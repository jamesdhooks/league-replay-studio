"""
llm_service.py
--------------
Core LLM integration layer for League Replay Studio.

Architecture
~~~~~~~~~~~~
The service uses a **skill-based** design where each AI capability is
encapsulated as an ``LLMSkill``.  Skills own their system prompts, output
schemas, and validation logic — so callers only need to supply a plain
natural-language user prompt plus optional context.

Provider abstraction
~~~~~~~~~~~~~~~~~~~~
All provider communication goes through raw ``httpx`` async HTTP calls
(no vendor SDKs).  Supported providers:

* **openai**    — GPT-4o, GPT-4o-mini, etc.
* **anthropic** — Claude 3.5 Sonnet, Claude 3 Haiku, etc.
* **google**    — Gemini 1.5 Pro, Gemini 1.5 Flash, etc.
* **custom**    — Any OpenAI-compatible endpoint.
* **none**      — LLM features disabled.

Configuration is read from ``settings_service`` at call time so hot-
reloading works without a restart.

Singleton
~~~~~~~~~
Import the ready-made instance::

    from server.services.llm_service import llm_service
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from abc import ABC, abstractmethod
from typing import Any, Optional

import httpx

from server.services.settings_service import settings_service

logger = logging.getLogger(__name__)

# ── Provider API endpoints ──────────────────────────────────────────────────

_OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
_ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
_GOOGLE_API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# ── Retry / timeout defaults ───────────────────────────────────────────────

_MAX_RETRIES = 3
_INITIAL_BACKOFF = 1.0  # seconds
_HTTP_TIMEOUT = 60.0  # seconds per request

# ── Exceptions ──────────────────────────────────────────────────────────────


class LLMProviderError(Exception):
    """Raised when a provider API call fails.

    Attributes
    ----------
    provider : str
        The provider that failed (e.g. ``"openai"``).
    status_code : int | None
        HTTP status code returned by the provider, if available.
    detail : str
        Human-readable error detail from the provider response.
    """

    def __init__(
        self,
        message: str,
        *,
        provider: str = "",
        status_code: Optional[int] = None,
        detail: str = "",
    ) -> None:
        self.provider = provider
        self.status_code = status_code
        self.detail = detail
        super().__init__(message)


class LLMConfigError(Exception):
    """Raised when LLM configuration is missing or invalid."""


class LLMSkillError(Exception):
    """Raised when skill execution or output validation fails."""


class LLMNotAvailableError(Exception):
    """Raised when LLM features are disabled or not configured."""


# ── LLMSkill base class ────────────────────────────────────────────────────


class LLMSkill(ABC):
    """Base class for every LLM skill.

    A *skill* encapsulates a single AI capability.  Subclasses must provide:

    * ``skill_id`` — unique identifier used in ``execute_skill()``.
    * ``name`` / ``description`` — human-readable metadata.
    * ``build_system_prompt()`` — constructs the system prompt, injecting
      caller-supplied *context* into the template.
    * ``get_response_schema()`` — JSON Schema describing the expected
      structured output.
    * ``validate_output()`` — checks a parsed dict and returns
      ``(is_valid, error_message)``.

    The default ``parse_response()`` implementation extracts the first
    JSON object from the raw LLM text, which covers the vast majority of
    use-cases.
    """

    skill_id: str
    name: str
    description: str

    @abstractmethod
    def build_system_prompt(self, context: dict) -> str:
        """Return the full system prompt for this skill.

        Parameters
        ----------
        context:
            Arbitrary key/value pairs the caller wants injected into the
            prompt (e.g. current project metadata, available cameras).
        """

    @abstractmethod
    def get_response_schema(self) -> dict:
        """Return a JSON Schema dict describing the expected output."""

    @abstractmethod
    def validate_output(self, output: dict) -> tuple[bool, str]:
        """Validate a parsed output dict.

        Returns
        -------
        tuple[bool, str]
            ``(True, "")`` on success, ``(False, "reason")`` on failure.
        """

    def parse_response(self, raw_response: str) -> dict:
        """Extract a JSON object from the raw LLM response text.

        The method first attempts a plain ``json.loads`` on the full
        string.  If that fails it looks for a fenced code block
        (````json … ````), and finally falls back to the first ``{ … }``
        substring.

        Raises
        ------
        LLMSkillError
            If no valid JSON object can be extracted.
        """
        text = raw_response.strip()

        # 1. Direct parse
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass

        # 2. Fenced code block (```json ... ``` or ``` ... ```)
        fence_match = re.search(
            r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL
        )
        if fence_match:
            try:
                parsed = json.loads(fence_match.group(1).strip())
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass

        # 3. First { … } substring (greedy from first '{' to last '}')
        brace_match = re.search(r"\{.*\}", text, re.DOTALL)
        if brace_match:
            try:
                parsed = json.loads(brace_match.group(0))
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass

        raise LLMSkillError(
            f"Skill '{self.skill_id}': could not extract JSON from LLM response"
        )


# ── LLMService ──────────────────────────────────────────────────────────────


class LLMService:
    """Central service for LLM interactions.

    *  Reads provider configuration from ``settings_service`` on every call
       so changes take effect immediately.
    *  Manages a registry of :class:`LLMSkill` instances.
    *  Routes requests to the configured provider via raw HTTP.
    """

    def __init__(self) -> None:
        self._skills: dict[str, LLMSkill] = {}
        logger.info("[LLM] LLMService initialised")

    # ── Configuration helpers ───────────────────────────────────────────────

    def _get_config(self) -> dict[str, Any]:
        """Read LLM-related settings from settings_service."""
        return {
            "provider": settings_service.get("llm_provider", "none"),
            "api_key": settings_service.get("llm_api_key", ""),
            "model": settings_service.get("llm_model", ""),
            "custom_endpoint": settings_service.get("llm_custom_endpoint", ""),
            "temperature": float(settings_service.get("llm_temperature", 0.3)),
            "enabled": bool(settings_service.get("llm_enabled", False)),
        }

    def is_available(self) -> bool:
        """Return ``True`` if LLM features are enabled and a key is set."""
        cfg = self._get_config()
        if not cfg["enabled"]:
            return False
        if cfg["provider"] == "none":
            return False
        if not cfg["api_key"]:
            return False
        return True

    def get_provider_info(self) -> dict:
        """Return a summary of the current provider configuration.

        Useful for the frontend settings panel or health-check endpoint.
        """
        cfg = self._get_config()
        return {
            "provider": cfg["provider"],
            "model": cfg["model"],
            "enabled": cfg["enabled"],
            "available": self.is_available(),
            "custom_endpoint": cfg["custom_endpoint"] or None,
            "skills": list(self._skills.keys()),
        }

    # ── Skill registry ──────────────────────────────────────────────────────

    def register_skill(self, skill: LLMSkill) -> None:
        """Register an :class:`LLMSkill` instance.

        Raises
        ------
        ValueError
            If a skill with the same ``skill_id`` is already registered.
        """
        if skill.skill_id in self._skills:
            raise ValueError(
                f"Skill '{skill.skill_id}' is already registered"
            )
        self._skills[skill.skill_id] = skill
        logger.info("[LLM] Registered skill '%s' (%s)", skill.skill_id, skill.name)

    # ── Skill execution ─────────────────────────────────────────────────────

    async def execute_skill(
        self,
        skill_id: str,
        user_prompt: str,
        context: Optional[dict] = None,
    ) -> dict:
        """Execute a registered skill and return the validated output.

        Parameters
        ----------
        skill_id:
            The ``skill_id`` of a previously registered skill.
        user_prompt:
            Plain natural-language instruction from the user.
        context:
            Optional key/value pairs injected into the skill's system
            prompt (e.g. project metadata, available cameras).

        Returns
        -------
        dict
            Validated structured output from the LLM.

        Raises
        ------
        LLMNotAvailableError
            If LLM features are disabled or not configured.
        LLMSkillError
            If the skill is unknown, or output validation fails.
        LLMProviderError
            If the provider API call fails after retries.
        """
        if not self.is_available():
            raise LLMNotAvailableError(
                "LLM is disabled or not configured — check settings"
            )

        skill = self._skills.get(skill_id)
        if skill is None:
            raise LLMSkillError(f"Unknown skill: '{skill_id}'")

        ctx = context or {}
        system_prompt = skill.build_system_prompt(ctx)
        response_schema = skill.get_response_schema()

        logger.info(
            "[LLM] Executing skill '%s' (model=%s)",
            skill_id,
            self._get_config()["model"],
        )

        raw = await self._call_provider(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_format=response_schema,
        )

        # Parse and validate
        try:
            output = skill.parse_response(raw)
        except LLMSkillError:
            raise
        except Exception as exc:
            raise LLMSkillError(
                f"Skill '{skill_id}': failed to parse LLM response — {exc}"
            ) from exc

        valid, error_msg = skill.validate_output(output)
        if not valid:
            raise LLMSkillError(
                f"Skill '{skill_id}': output validation failed — {error_msg}"
            )

        logger.info("[LLM] Skill '%s' completed successfully", skill_id)
        return output

    # ── Provider dispatch ───────────────────────────────────────────────────

    async def _call_provider(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[dict] = None,
    ) -> str:
        """Send a prompt to the configured provider and return raw text.

        Implements retry with exponential backoff (up to ``_MAX_RETRIES``
        attempts).  Raises :class:`LLMProviderError` if all attempts fail.
        """
        cfg = self._get_config()
        provider = cfg["provider"]

        if provider == "none":
            raise LLMConfigError("LLM provider is set to 'none'")

        dispatchers = {
            "openai": self._call_openai,
            "anthropic": self._call_anthropic,
            "google": self._call_google,
            "custom": self._call_custom,
        }

        dispatch_fn = dispatchers.get(provider)
        if dispatch_fn is None:
            raise LLMConfigError(f"Unsupported LLM provider: '{provider}'")

        last_exc: Optional[Exception] = None

        for attempt in range(1, _MAX_RETRIES + 1):
            t0 = time.monotonic()
            try:
                result = await dispatch_fn(
                    cfg=cfg,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_format,
                )
                elapsed = time.monotonic() - t0
                logger.info(
                    "[LLM] %s call succeeded in %.2fs (attempt %d)",
                    provider,
                    elapsed,
                    attempt,
                )
                return result
            except LLMProviderError as exc:
                elapsed = time.monotonic() - t0
                last_exc = exc
                logger.warning(
                    "[LLM] %s call failed in %.2fs (attempt %d/%d): %s",
                    provider,
                    elapsed,
                    attempt,
                    _MAX_RETRIES,
                    exc,
                )
                if attempt < _MAX_RETRIES:
                    backoff = _INITIAL_BACKOFF * (2 ** (attempt - 1))
                    await asyncio.sleep(backoff)

        raise last_exc  # type: ignore[misc]

    # ── OpenAI ──────────────────────────────────────────────────────────────

    async def _call_openai(
        self,
        cfg: dict,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[dict] = None,
    ) -> str:
        """Call the OpenAI Chat Completions API."""
        headers = {
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": cfg["model"],
            "temperature": cfg["temperature"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if response_format:
            body["response_format"] = {"type": "json_object"}

        return await self._post(
            url=_OPENAI_API_URL,
            headers=headers,
            body=body,
            provider="openai",
            extract=self._extract_openai,
        )

    @staticmethod
    def _extract_openai(data: dict) -> str:
        """Extract assistant message text from an OpenAI response."""
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMProviderError(
                "Unexpected OpenAI response structure",
                provider="openai",
                detail=str(exc),
            ) from exc

    # ── Anthropic ───────────────────────────────────────────────────────────

    async def _call_anthropic(
        self,
        cfg: dict,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[dict] = None,
    ) -> str:
        """Call the Anthropic Messages API."""
        headers = {
            "x-api-key": cfg["api_key"],
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        body: dict[str, Any] = {
            "model": cfg["model"],
            "max_tokens": 4096,
            "temperature": cfg["temperature"],
            "system": system_prompt,
            "messages": [
                {"role": "user", "content": user_prompt},
            ],
        }

        return await self._post(
            url=_ANTHROPIC_API_URL,
            headers=headers,
            body=body,
            provider="anthropic",
            extract=self._extract_anthropic,
        )

    @staticmethod
    def _extract_anthropic(data: dict) -> str:
        """Extract text from an Anthropic Messages response."""
        try:
            for block in data["content"]:
                if block.get("type") == "text":
                    return block["text"]
            raise LLMProviderError(
                "No text block in Anthropic response",
                provider="anthropic",
            )
        except (KeyError, TypeError) as exc:
            raise LLMProviderError(
                "Unexpected Anthropic response structure",
                provider="anthropic",
                detail=str(exc),
            ) from exc

    # ── Google (Gemini) ─────────────────────────────────────────────────────

    async def _call_google(
        self,
        cfg: dict,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[dict] = None,
    ) -> str:
        """Call the Google Gemini ``generateContent`` API."""
        url = _GOOGLE_API_URL.format(model=cfg["model"])
        headers = {"Content-Type": "application/json"}
        params = {"key": cfg["api_key"]}
        body: dict[str, Any] = {
            "contents": [
                {"role": "user", "parts": [{"text": user_prompt}]},
            ],
            "systemInstruction": {
                "parts": [{"text": system_prompt}],
            },
            "generationConfig": {
                "temperature": cfg["temperature"],
            },
        }
        if response_format:
            body["generationConfig"]["responseMimeType"] = "application/json"

        return await self._post(
            url=url,
            headers=headers,
            body=body,
            provider="google",
            extract=self._extract_google,
            params=params,
        )

    @staticmethod
    def _extract_google(data: dict) -> str:
        """Extract text from a Gemini generateContent response."""
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMProviderError(
                "Unexpected Google Gemini response structure",
                provider="google",
                detail=str(exc),
            ) from exc

    # ── Custom (OpenAI-compatible) ──────────────────────────────────────────

    async def _call_custom(
        self,
        cfg: dict,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[dict] = None,
    ) -> str:
        """Call a custom OpenAI-compatible endpoint."""
        endpoint = cfg["custom_endpoint"]
        if not endpoint:
            raise LLMConfigError(
                "Custom provider selected but 'llm_custom_endpoint' is empty"
            )

        # Normalise: ensure we target the chat completions path
        base = endpoint.rstrip("/")
        if not base.endswith("/chat/completions"):
            base = f"{base}/chat/completions"

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if cfg["api_key"]:
            headers["Authorization"] = f"Bearer {cfg['api_key']}"

        body: dict[str, Any] = {
            "model": cfg["model"],
            "temperature": cfg["temperature"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if response_format:
            body["response_format"] = {"type": "json_object"}

        return await self._post(
            url=base,
            headers=headers,
            body=body,
            provider="custom",
            extract=self._extract_openai,  # same response format
        )

    # ── Shared HTTP helper ──────────────────────────────────────────────────

    @staticmethod
    async def _post(
        url: str,
        headers: dict[str, str],
        body: dict[str, Any],
        provider: str,
        extract: Any,
        params: Optional[dict[str, str]] = None,
    ) -> str:
        """POST JSON to *url*, parse the response, and extract the text.

        Raises :class:`LLMProviderError` on any HTTP or parsing failure.
        """
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            try:
                resp = await client.post(
                    url, headers=headers, json=body, params=params
                )
            except httpx.HTTPError as exc:
                raise LLMProviderError(
                    f"{provider} HTTP request failed: {exc}",
                    provider=provider,
                    detail=str(exc),
                ) from exc

        if resp.status_code >= 400:
            # Try to pull a useful message from the error body
            try:
                err_body = resp.json()
                detail = (
                    err_body.get("error", {}).get("message", "")
                    if isinstance(err_body.get("error"), dict)
                    else str(err_body.get("error", resp.text[:500]))
                )
            except Exception:
                detail = resp.text[:500]

            raise LLMProviderError(
                f"{provider} API returned HTTP {resp.status_code}",
                provider=provider,
                status_code=resp.status_code,
                detail=detail,
            )

        try:
            data = resp.json()
        except Exception as exc:
            raise LLMProviderError(
                f"{provider} returned non-JSON response",
                provider=provider,
                detail=str(exc),
            ) from exc

        return extract(data)


# ── Module-level singleton ──────────────────────────────────────────────────
llm_service = LLMService()
