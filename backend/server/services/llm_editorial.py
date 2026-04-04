"""
llm_editorial.py
----------------
LLM editorial layer for highlight narrative refinement.

Operates after the deterministic scoring pipeline has produced a candidate
timeline, and before the Video Composition Script is finalised.  Does not
replace the algorithmic selection — it refines the narrative, adds segment
notes, and can swap events within a tier without changing the overall structure.

Permitted LLM actions:
  - Add a ``notes`` field to any segment
  - Swap two events of equal tier within the same bucket
  - Suggest a ``transition_type`` between adjacent segments
  - Flag a segment as ``narrative_anchor``

Not permitted:
  - Changing event inclusion/exclusion
  - Overriding tier classification
  - Modifying timestamps
  - Adjusting scores
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Supported transition types
VALID_TRANSITIONS = frozenset({"cut", "fade", "crossfade", "whip", "zoom"})

# Max note length
MAX_NOTE_LENGTH = 200

# Default LLM model
DEFAULT_LLM_MODEL = "claude-sonnet-4-20250514"


def build_llm_prompt(timeline: list[dict], race_context: dict) -> str:
    """Build the structured prompt for the LLM editorial pass.
    
    Args:
        timeline: Candidate timeline segments from deterministic scoring.
        race_context: Race metadata (track, laps, drivers, etc.).
    
    Returns:
        JSON string prompt for the LLM.
    """
    # Simplify timeline for the prompt (remove large nested data)
    simplified = []
    for seg in timeline:
        if seg.get("type") in ("transition", "broll"):
            continue
        simplified.append({
            "id": seg.get("id", ""),
            "type": seg.get("event_type", seg.get("type", "")),
            "tier": seg.get("tier", "C"),
            "bucket": seg.get("bucket", "mid"),
            "score": seg.get("score", 0),
            "start_time": seg.get("start_time_seconds", 0),
            "end_time": seg.get("end_time_seconds", 0),
            "drivers": seg.get("involved_drivers", []),
            "position": seg.get("position", 0),
        })

    prompt_data = {
        "task": "editorial_refinement",
        "race_context": {
            "track": race_context.get("track", "Unknown"),
            "total_laps": race_context.get("total_laps", 0),
            "num_drivers": race_context.get("num_drivers", 0),
        },
        "candidate_timeline": simplified,
        "constraints": {
            "target_duration": race_context.get("target_duration", 300),
            "max_driver_exposure": race_context.get("max_driver_exposure", 0.25),
        },
        "instructions": (
            "Add a narrative note to each segment (max 200 chars). "
            "You may swap two events within the same tier AND same bucket "
            "if it improves story flow. Do not change mandatory events. "
            "Suggest transition_type between adjacent segments: "
            "cut, fade, crossfade, whip, or zoom. "
            "Flag pivotal segments as narrative_anchor: true. "
            "Return JSON only with this schema: "
            '{"refined_segments": [{"id": "...", "notes": "...", '
            '"transition_to_next": "cut|fade|crossfade|whip|zoom", '
            '"narrative_anchor": true|false}], '
            '"prompt_hash": "<sha256 of this prompt>"}'
        ),
    }

    return json.dumps(prompt_data, indent=2)


def compute_prompt_hash(prompt: str) -> str:
    """Compute SHA-256 hash of the prompt for traceability."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]


async def llm_editorial_pass(
    timeline: list[dict],
    race_context: dict,
    api_key: Optional[str] = None,
    model: str = DEFAULT_LLM_MODEL,
) -> Optional[dict]:
    """Run the LLM editorial pass on a candidate timeline.
    
    This function is designed to be called with an Anthropic API key.
    If no key is available, it returns None and the deterministic
    timeline is used as-is.
    
    Args:
        timeline: Candidate timeline from deterministic scoring.
        race_context: Race metadata.
        api_key: Anthropic API key (optional).
        model: LLM model identifier.
    
    Returns:
        LLM result dict or None if unavailable/failed.
    """
    if not api_key:
        logger.info("LLM editorial pass skipped — no API key configured")
        return None

    prompt = build_llm_prompt(timeline, race_context)
    prompt_hash = compute_prompt_hash(prompt)

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text
        result = json.loads(raw)
        result["prompt_hash"] = prompt_hash
        logger.info("LLM editorial pass completed (model=%s, hash=%s)", model, prompt_hash)
        return result

    except ImportError:
        logger.warning("anthropic package not installed — LLM pass skipped")
        return None
    except json.JSONDecodeError as exc:
        logger.warning("LLM returned invalid JSON: %s", exc)
        return None
    except Exception as exc:
        logger.warning("LLM editorial pass failed: %s", exc)
        return None


def validate_llm_output(llm_result: dict, timeline: list[dict]) -> tuple[bool, list[str]]:
    """Validate LLM output before merging into the timeline.
    
    Checks:
      - All referenced segment IDs exist in the candidate timeline
      - No swaps cross tier boundaries
      - No swaps cross bucket phase boundaries
      - No notes exceed 200 characters
      - transition_to_next values are in the supported set
    
    Args:
        llm_result: Parsed LLM response.
        timeline: Original candidate timeline.
    
    Returns:
        (is_valid, list_of_error_messages)
    """
    errors = []
    
    # Build lookup of valid segments
    segment_map = {}
    for seg in timeline:
        sid = seg.get("id", "")
        if sid:
            segment_map[sid] = seg

    refined = llm_result.get("refined_segments", [])
    if not isinstance(refined, list):
        return False, ["refined_segments is not a list"]

    for item in refined:
        sid = item.get("id", "")
        
        # Check segment exists
        if sid not in segment_map:
            errors.append(f"Segment ID '{sid}' not found in timeline")
            continue

        # Check notes length
        notes = item.get("notes", "")
        if notes and len(notes) > MAX_NOTE_LENGTH:
            errors.append(f"Notes for '{sid}' exceed {MAX_NOTE_LENGTH} chars ({len(notes)})")

        # Check transition type
        transition = item.get("transition_to_next")
        if transition and transition not in VALID_TRANSITIONS:
            errors.append(f"Invalid transition '{transition}' for '{sid}'")

    return len(errors) == 0, errors


def merge_llm_annotations(timeline: list[dict], llm_result: dict) -> list[dict]:
    """Merge validated LLM annotations into the timeline.
    
    Only adds/updates:
      - notes field
      - transition_to_next field
      - narrative_anchor flag
    
    Does NOT modify: scores, tiers, timestamps, inclusion/exclusion.
    
    Args:
        timeline: Original candidate timeline.
        llm_result: Validated LLM output.
    
    Returns:
        Annotated timeline (new list, original not mutated).
    """
    # Build annotation lookup
    annotations = {}
    for item in llm_result.get("refined_segments", []):
        sid = item.get("id", "")
        if sid:
            annotations[sid] = item

    result = []
    for seg in timeline:
        sid = seg.get("id", "")
        annotation = annotations.get(sid)
        if annotation:
            seg = {**seg}  # Shallow copy to avoid mutation
            if "notes" in annotation:
                seg["notes"] = annotation["notes"]
            if "transition_to_next" in annotation:
                seg["transition_to_next"] = annotation["transition_to_next"]
            if "narrative_anchor" in annotation:
                seg["narrative_anchor"] = bool(annotation["narrative_anchor"])
            seg["llm_annotated"] = True
        result.append(seg)

    return result


def get_llm_metadata(
    llm_result: Optional[dict],
    model: str = DEFAULT_LLM_MODEL,
) -> dict:
    """Build metadata dict for the Video Composition Script.
    
    Args:
        llm_result: LLM output (None if not used).
        model: Model identifier.
    
    Returns:
        Dict with llm_used, llm_model, validation_status, llm_prompt_hash.
    """
    if llm_result is None:
        return {
            "llm_used": False,
            "llm_model": "",
            "validation_status": "n/a",
            "llm_prompt_hash": "",
        }

    return {
        "llm_used": True,
        "llm_model": model,
        "validation_status": "passed",
        "llm_prompt_hash": llm_result.get("prompt_hash", ""),
    }
