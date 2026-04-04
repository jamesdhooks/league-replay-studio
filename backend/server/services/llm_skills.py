"""
llm_skills.py
-------------
Built-in LLM skills for League Replay Studio.

Each skill encapsulates a complete AI capability — from system-prompt
construction through output validation — so callers only need a simple
natural-language request plus optional context.

Skills
~~~~~~
* **EditorialSkill** — refine highlight composition scripts with
  narrative notes, transitions, and anchor flags.
* **OverlayDesignSkill** — generate new broadcast overlay elements from
  natural language descriptions.
* **OverlayAugmentSkill** — modify existing overlay elements (reposition,
  restyle, add data) via natural language.

Usage::

    from server.services.llm_skills import register_default_skills
    register_default_skills()
"""

from __future__ import annotations

import json
import logging
import re
import textwrap
from typing import Any

from server.services.llm_service import LLMSkill
from server.services.preset_service import DEFAULT_ELEMENTS

logger = logging.getLogger(__name__)

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

# ── Helper ──────────────────────────────────────────────────────────────────


def _elements_summary(elements: dict[str, list[dict[str, Any]]]) -> str:
    """Serialize DEFAULT_ELEMENTS into a compact text block for prompts."""
    parts: list[str] = []
    for section, elems in elements.items():
        for el in elems:
            tpl = el.get("template", "")
            # Compact whitespace for prompt size
            tpl_compact = " ".join(tpl.split())
            pos = el.get("position", {})
            parts.append(
                f"--- SECTION: {section} ---\n"
                f"id: {el['id']}\n"
                f"name: {el['name']}\n"
                f"position: {{ x: {pos.get('x', 0)}, y: {pos.get('y', 0)}, "
                f"w: {pos.get('w', 0)}, h: {pos.get('h', 0)} }}\n"
                f"z_index: {el.get('z_index', 10)}\n"
                f"visible: {el.get('visible', True)}\n"
                f"template: |\n  {tpl_compact}\n"
            )
    return "\n".join(parts)


# ═══════════════════════════════════════════════════════════════════════════
#  Skill 1 — Editorial
# ═══════════════════════════════════════════════════════════════════════════


class EditorialSkill(LLMSkill):
    """Refine highlight video composition scripts with narrative polish.

    The LLM acts as a professional broadcast editor: it adds narrative
    notes, suggests transitions, flags anchor moments, and optionally
    swaps same-tier events for better storytelling — all without changing
    inclusion/exclusion or scoring.
    """

    skill_id = "editorial"
    name = "Editorial Refinement"
    description = (
        "Refine a highlight composition with narrative notes, "
        "transition suggestions, anchor flags, and same-tier swaps."
    )

    # ── prompt ──────────────────────────────────────────────────────────

    def build_system_prompt(self, context: dict) -> str:
        timeline_json = json.dumps(context.get("timeline", []), indent=2)
        scored_json = json.dumps(context.get("scored_events", []), indent=2)
        metrics_json = json.dumps(context.get("metrics", {}), indent=2)
        race_info = context.get("race_info", {})

        return textwrap.dedent(f"""\
            You are a professional motorsport broadcast editor working on a
            highlight video for League Replay Studio.

            ── VIDEO STRUCTURE ──
            The video has four sequential sections:
              1. intro            — title card, series branding, atmosphere.
              2. qualifying_results — starting grid / qualifying standings.
              3. race             — the main race highlight reel.
              4. race_results     — final standings, podium.

            Each section contains scored timeline *segments*.  Every segment
            carries an event tier (S / A / B / C / D), timestamps, and a
            numeric score that determined its inclusion.

            ── RACE INFORMATION ──
            Track:    {race_info.get("track_name", "Unknown")}
            Series:   {race_info.get("series", "Unknown")}
            Drivers:  {race_info.get("driver_count", "Unknown")}
            Duration: {race_info.get("race_duration", "Unknown")}

            ── WHAT YOU RECEIVE ──
            1. The full scored timeline (segments already selected for the
               highlight video):
            {timeline_json}

            2. All scored events with tiers (including those NOT selected):
            {scored_json}

            3. Highlight metrics (duration, coverage, etc.):
            {metrics_json}

            ── WHAT YOU CAN DO ──
            • Add a "notes" string to any segment — editorial commentary for
              the human editor (e.g. "great overtake, hold this shot").
            • Suggest a "transition_type" for the cut between segments.
              Allowed values: "cut", "fade", "crossfade", "whip", "zoom".
            • Flag "narrative_anchor" = true on key story-turning-point
              segments (first lap, decisive overtake, incident, finish).
            • Swap two segments that share the SAME tier AND sit in the SAME
              section, if reordering improves narrative flow.  Use the
              "swap_with" action for this.

            ── WHAT YOU CANNOT DO ──
            • Do NOT change inclusion or exclusion of segments.
            • Do NOT override tier assignments.
            • Do NOT modify timestamps or durations.
            • Do NOT adjust numeric scores.

            ── OUTPUT FORMAT ──
            Return a single JSON object with two keys:

            {{
              "modifications": [
                {{
                  "segment_id": "<id of the segment to modify>",
                  "action": "add_note" | "set_transition" | "flag_anchor" | "swap_with",
                  "value": "<string or object depending on action>"
                }}
              ],
              "narrative_summary": "A brief text summary of the race storyline."
            }}

            For "add_note":      value is the note text (string).
            For "set_transition": value is one of "cut","fade","crossfade","whip","zoom".
            For "flag_anchor":   value is true (boolean).
            For "swap_with":     value is the segment_id to swap with (string).

            Return ONLY the JSON object.  No markdown fences, no commentary.
        """)

    # ── schema ──────────────────────────────────────────────────────────

    def get_response_schema(self) -> dict:
        return {
            "type": "object",
            "required": ["modifications", "narrative_summary"],
            "properties": {
                "modifications": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["segment_id", "action", "value"],
                        "properties": {
                            "segment_id": {"type": "string"},
                            "action": {
                                "type": "string",
                                "enum": [
                                    "add_note",
                                    "set_transition",
                                    "flag_anchor",
                                    "swap_with",
                                ],
                            },
                            "value": {},
                        },
                    },
                },
                "narrative_summary": {"type": "string"},
            },
        }

    # ── validation ──────────────────────────────────────────────────────

    _VALID_ACTIONS = {"add_note", "set_transition", "flag_anchor", "swap_with"}
    _VALID_TRANSITIONS = {"cut", "fade", "crossfade", "whip", "zoom"}

    def validate_output(self, output: dict) -> tuple[bool, str]:
        if "modifications" not in output:
            logger.warning("[EditorialSkill] validation failed: Missing 'modifications' key")
            return False, "Missing 'modifications' key."
        if "narrative_summary" not in output:
            logger.warning("[EditorialSkill] validation failed: Missing 'narrative_summary' key")
            return False, "Missing 'narrative_summary' key."
        if not isinstance(output["modifications"], list):
            return False, "'modifications' must be a list."
        if not isinstance(output["narrative_summary"], str):
            return False, "'narrative_summary' must be a string."

        for i, mod in enumerate(output["modifications"]):
            if not isinstance(mod, dict):
                return False, f"modifications[{i}] is not an object."
            for key in ("segment_id", "action", "value"):
                if key not in mod:
                    return False, f"modifications[{i}] missing '{key}'."

            action = mod["action"]
            if action not in self._VALID_ACTIONS:
                return False, (
                    f"modifications[{i}].action '{action}' not in "
                    f"{self._VALID_ACTIONS}."
                )

            if action == "set_transition":
                if mod["value"] not in self._VALID_TRANSITIONS:
                    return False, (
                        f"modifications[{i}].value '{mod['value']}' is not a "
                        f"valid transition type {self._VALID_TRANSITIONS}."
                    )

            if action == "flag_anchor":
                if mod["value"] is not True:
                    return False, (
                        f"modifications[{i}].value must be true for "
                        f"'flag_anchor' action."
                    )

            if action == "swap_with":
                if not isinstance(mod["value"], str) or not mod["value"]:
                    return False, (
                        f"modifications[{i}].value must be a non-empty "
                        f"segment_id string for 'swap_with'."
                    )

        logger.info("[EditorialSkill] validation passed: %d modifications", len(output["modifications"]))
        return True, ""
# ═══════════════════════════════════════════════════════════════════════════
#  Template variable reference (shared by overlay skills)
# ═══════════════════════════════════════════════════════════════════════════

_TEMPLATE_VARIABLE_REFERENCE = """\
TEMPLATE VARIABLE REFERENCE
============================

All overlay element templates use Jinja2 syntax.  The render engine
provides three namespaces of variables.  You MUST only use variables
from these namespaces.

Frame Variables  ({{ frame.* }})
--------------------------------
  frame.section          : string   — Current video section:
                                      "intro", "qualifying_results",
                                      "race", or "race_results".
  frame.series_name      : string   — Racing series name
                                      (e.g. "iRacing Formula 4").
  frame.track_name       : string   — Track name
                                      (e.g. "Brands Hatch GP").
  frame.current_lap      : int      — Current lap number.
  frame.total_laps       : int      — Total laps in race.
  frame.session_time     : string   — Formatted "HH:MM:SS".
  frame.driver_name      : string|null — Focused driver's name.
  frame.car_name         : string|null — Focused driver's car class.
  frame.position         : int|null — Focused driver's race position.
  frame.irating          : int      — Focused driver's iRating.
  frame.team_color       : string   — Hex colour for team/driver.
  frame.last_lap_time    : string|null — Last lap time formatted.
  frame.best_lap_time    : string|null — Best lap time formatted.
  frame.flag             : string   — "green", "yellow", "red",
                                      "checkered".
  frame.incident_count   : int      — Number of incidents.
  frame.standings        : array    — Race standings.  Each entry:
      .position       : int
      .driver_name    : string
      .car_number     : string
      .is_player      : bool   — Whether this is the focused/hero
                                 driver.
      .gap            : string — "+1.234", "+5.4", or "Leader".

Position Context  ({{ pos.* }})
-------------------------------
  pos.x   : float — Element left position (%).
  pos.y   : float — Element top position (%).
  pos.w   : float — Element width (%).
  pos.h   : float — Element height (%).

CSS Variables  ({{ vars.* }})
-----------------------------
  vars.--color-primary     : string  — Primary text colour
                                       (default "#ffffff").
  vars.--color-secondary   : string  — Secondary text colour
                                       (default "#cccccc").
  vars.--color-accent      : string  — Accent/highlight colour
                                       (default "#3B82F6").
  vars.--color-background  : string  — Background colour
                                       (default "rgba(0,0,0,0.75)").
  vars.--font-primary      : string  — Primary font family.
  vars.--font-mono         : string  — Monospace font family.

  User-defined custom variables are also available under vars.*
"""

# ═══════════════════════════════════════════════════════════════════════════
#  Skill 2 — Overlay Design
# ═══════════════════════════════════════════════════════════════════════════


class OverlayDesignSkill(LLMSkill):
    """Generate new broadcast overlay elements from natural language.

    The system prompt contains the complete template variable reference,
    CSS variable system, positioning rules, pagination system, and real
    working examples from the default preset — so the user only needs to
    say things like *"create a battle indicator that shows when two cars
    are close"*.
    """

    skill_id = "overlay_design"
    name = "Overlay Element Designer"
    description = (
        "Generate a new broadcast overlay element from a natural-"
        "language description."
    )

    # ── prompt ──────────────────────────────────────────────────────────

    def build_system_prompt(self, context: dict) -> str:
        section = context.get("section", "race")
        existing = json.dumps(context.get("existing_elements", []), indent=2)
        preset_vars = json.dumps(context.get("preset_variables", {}), indent=2)
        available_assets = json.dumps(
            context.get("available_assets", []), indent=2
        )
        ref_examples = _elements_summary(DEFAULT_ELEMENTS)

        return textwrap.dedent(f"""\
            You are an expert broadcast graphics designer for motorsport
            overlays in League Replay Studio.

            Your task is to create a NEW overlay element based on the user's
            natural-language description.  You will return a single JSON
            object containing the full element definition.

            ═══════════════════════════════════════════════════════
            {_TEMPLATE_VARIABLE_REFERENCE}
            ═══════════════════════════════════════════════════════

            POSITIONING RULES
            =================
            • All elements use CSS percentage-based positioning so they
              are resolution-independent.
            • An element's position is specified as a JSON object:
                {{ "x": <left%>, "y": <top%>, "w": <width%>, "h": <height%> }}
              where all values are 0–100.
            • The render engine places your template HTML inside a wrapper
              ``<div>`` with:
                position:absolute; left:X%; top:Y%; width:W%; height:H%
              so do NOT add ``position:absolute`` in your template — the
              wrapper handles it.
            • Use ``var(--color-primary)`` etc. for colours so the user's
              theme applies automatically.
            • Use ``clamp(<min>, <preferred>, <max>)`` for font sizes so
              text scales with resolution.
            • All styling MUST be inline (no external stylesheets).

            PAGINATION SYSTEM
            =================
            For elements that display lists (standings, results) you can
            enable automatic page cycling:

              "pagination": {{
                "enabled": true,
                "items_per_page": 10,
                "cycle_duration_seconds": 5
              }}

            In the template use:
              {{% for entry in frame.standings[page_start:page_end] %}}
            The render engine supplies ``page_start`` and ``page_end``
            automatically when pagination is enabled.

            SECTION AWARENESS
            =================
            The element will be placed in the **{section}** section.

            Section data guidance:
            • intro — frame.series_name, frame.track_name are most
              relevant.  Standings may not be populated yet.
            • qualifying_results — frame.standings contains the
              qualifying order.  No lap data.
            • race — all frame.* variables are available and update
              every frame.  frame.standings shows live positions.
            • race_results — frame.standings contains final results.
              frame.flag is "checkered".

            REFERENCE EXAMPLES
            ===================
            Below are the DEFAULT elements shipped with the application.
            Study them carefully — they demonstrate the exact Jinja2
            template syntax, CSS variable usage, clamp() font sizing, and
            positioning conventions that your output must follow.

            {ref_examples}

            ADDITIONAL REFERENCE ELEMENTS
            ==============================

            --- Battle Indicator (race section) ---
            id: battle_indicator
            name: Battle Indicator
            position: {{ x: 35, y: 82, w: 30, h: 10 }}
            z_index: 15
            visible: true
            template: |
              <div style="display:flex; align-items:center; justify-content:center; gap:0.6em;
                font-family: var(--font-primary, 'Inter', sans-serif);
                color: var(--color-primary, #ffffff);
                background: rgba(220,38,38,0.8); border-radius: 6px; padding: 0.4em 1em;
                font-size: clamp(0.5rem, 0.9vw, 1rem); font-weight:700;
                opacity: {{% if frame.standings | length >= 2 and frame.position is not none %}}
                  {{% set driver_gap = frame.standings | selectattr('is_player', 'true') | first %}}
                  {{% if driver_gap and driver_gap.gap and driver_gap.gap != 'Leader' and driver_gap.gap | replace('+','') | float < 1.0 %}}1{{% else %}}0{{% endif %}}
                {{% else %}}0{{% endif %}};">
                ⚔ BATTLE · {{{{ frame.driver_name | default('Driver') }}}}
              </div>

            --- Final Results Board with Pagination (race_results section) ---
            id: paginated_results
            name: Paginated Results
            position: {{ x: 20, y: 8, w: 60, h: 84 }}
            z_index: 10
            visible: true
            pagination: {{ enabled: true, items_per_page: 10, cycle_duration_seconds: 5 }}
            template: |
              <div style="font-family: var(--font-primary, 'Inter', sans-serif);
                color: var(--color-primary, #ffffff);">
                <div style="font-size: clamp(0.9rem, 1.5vw, 1.5rem); font-weight:700;
                  text-transform:uppercase; letter-spacing:0.12em; margin-bottom:0.6em;
                  color: var(--color-accent, #F59E0B);">
                  Final Classification
                </div>
                {{% for entry in frame.standings[page_start:page_end] %}}
                <div style="display:flex; align-items:center; gap:0.5em;
                  padding:0.3em 0.6em; margin-bottom:2px; border-radius:4px;
                  background: {{% if entry.position == 1 %}}rgba(245,158,11,0.5){{% elif entry.is_player %}}rgba(59,130,246,0.6){{% else %}}rgba(0,0,0,0.65){{% endif %}};
                  font-size: clamp(0.5rem, 0.9vw, 0.9rem);">
                  <span style="font-weight:700; min-width:1.5em; text-align:right;">{{{{ entry.position }}}}</span>
                  <span style="flex:1; font-weight:{{% if entry.is_player or entry.position == 1 %}}700{{% else %}}400{{% endif %}};">{{{{ entry.driver_name }}}}</span>
                  <span style="opacity:0.7; font-variant-numeric:tabular-nums;">{{{{ entry.gap }}}}</span>
                </div>
                {{% endfor %}}
              </div>

            CURRENTLY EXISTING ELEMENTS IN THIS SECTION
            =============================================
            The following elements already exist — avoid id collisions and
            consider spatial overlap when choosing your position:

            {existing}

            CURRENT CSS VARIABLES (PRESET)
            ===============================
            {preset_vars}

            AVAILABLE ASSETS
            =================
            {available_assets}

            OUTPUT FORMAT
            ==============
            Return a single JSON object (no markdown fences, no extra text):

            {{
              "element": {{
                "id": "snake_case_unique_id",
                "name": "Human-Readable Name",
                "template": "<Jinja2 HTML string>",
                "position": {{ "x": <0-100>, "y": <0-100>, "w": <0-100>, "h": <0-100> }},
                "z_index": <0-100>,
                "visible": true,
                "pagination": {{
                  "enabled": <bool>,
                  "items_per_page": <int>,
                  "cycle_duration_seconds": <float>
                }}
              }},
              "explanation": "Brief description of what was created."
            }}

            The "pagination" field is optional — include it only when the
            element displays a paginated list.

            RULES
            =====
            1. The template MUST use ONLY documented template variables
               (frame.*, pos.*, vars.*).
            2. The template MUST use CSS variables for theming
               (var(--color-*), var(--font-*)).
            3. The template MUST use clamp() for font sizes.
            4. All styling MUST be inline — no <style> blocks or external CSS.
            5. The "id" must be lowercase alphanumeric with underscores or
               hyphens only.
            6. Position values must be 0–100.
            7. z_index must be 0–100.
            8. Do NOT add position:absolute in the template — the wrapper
               div handles positioning.
        """)

    # ── schema ──────────────────────────────────────────────────────────

    def get_response_schema(self) -> dict:
        return {
            "type": "object",
            "required": ["element", "explanation"],
            "properties": {
                "element": {
                    "type": "object",
                    "required": [
                        "id",
                        "name",
                        "template",
                        "position",
                        "z_index",
                        "visible",
                    ],
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                        "template": {"type": "string"},
                        "position": {
                            "type": "object",
                            "required": ["x", "y", "w", "h"],
                            "properties": {
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "w": {"type": "number"},
                                "h": {"type": "number"},
                            },
                        },
                        "z_index": {"type": "integer"},
                        "visible": {"type": "boolean"},
                        "pagination": {
                            "type": "object",
                            "properties": {
                                "enabled": {"type": "boolean"},
                                "items_per_page": {"type": "integer"},
                                "cycle_duration_seconds": {
                                    "type": "number",
                                },
                            },
                        },
                    },
                },
                "explanation": {"type": "string"},
            },
        }

    # ── validation ──────────────────────────────────────────────────────

    def validate_output(self, output: dict) -> tuple[bool, str]:
        if "element" not in output:
            logger.warning("[OverlayDesignSkill] validation failed: Missing 'element' key")
            return False, "Missing 'element' key."
        if "explanation" not in output:
            logger.warning("[OverlayDesignSkill] validation failed: Missing 'explanation' key")
            return False, "Missing 'explanation' key."

        el = output["element"]
        if not isinstance(el, dict):
            logger.warning("[OverlayDesignSkill] validation failed: 'element' is not an object")
            return False, "'element' must be an object."

        # Required fields
        for key in ("id", "name", "template", "position", "z_index", "visible"):
            if key not in el:
                logger.warning("[OverlayDesignSkill] validation failed: missing field '%s'", key)
                return False, f"element missing required field '{key}'."

        ok, msg = _validate_element_fields(el)
        if ok:
            logger.info("[OverlayDesignSkill] validation passed: element '%s'", el.get("id"))
        else:
            logger.warning("[OverlayDesignSkill] validation failed: %s", msg)
        return ok, msg


# ═══════════════════════════════════════════════════════════════════════════
#  Skill 3 — Overlay Augment
# ═══════════════════════════════════════════════════════════════════════════


class OverlayAugmentSkill(LLMSkill):
    """Modify an existing overlay element via natural language.

    The system prompt includes the current element's template, position,
    and properties so the LLM can make targeted modifications — "make it
    bigger", "add team colours", "show more drivers", etc.
    """

    skill_id = "overlay_augment"
    name = "Overlay Element Augmenter"
    description = (
        "Modify an existing broadcast overlay element using a "
        "natural-language instruction."
    )

    # ── prompt ──────────────────────────────────────────────────────────

    def build_system_prompt(self, context: dict) -> str:
        section = context.get("section", "race")
        existing = json.dumps(context.get("existing_elements", []), indent=2)
        preset_vars = json.dumps(context.get("preset_variables", {}), indent=2)
        available_assets = json.dumps(
            context.get("available_assets", []), indent=2
        )
        target = context.get("target_element", {})
        target_json = json.dumps(target, indent=2)
        ref_examples = _elements_summary(DEFAULT_ELEMENTS)

        return textwrap.dedent(f"""\
            You are an expert broadcast graphics designer for motorsport
            overlays in League Replay Studio.

            Your task is to MODIFY an existing overlay element based on the
            user's natural-language instruction.  You must preserve the
            element's id and return the full modified element definition.

            ═══════════════════════════════════════════════════════
            {_TEMPLATE_VARIABLE_REFERENCE}
            ═══════════════════════════════════════════════════════

            POSITIONING RULES
            =================
            • All elements use CSS percentage-based positioning so they
              are resolution-independent.
            • An element's position is specified as a JSON object:
                {{ "x": <left%>, "y": <top%>, "w": <width%>, "h": <height%> }}
              where all values are 0–100.
            • The render engine places your template HTML inside a wrapper
              ``<div>`` with:
                position:absolute; left:X%; top:Y%; width:W%; height:H%
              so do NOT add ``position:absolute`` in your template — the
              wrapper handles it.
            • Use ``var(--color-primary)`` etc. for colours so the user's
              theme applies automatically.
            • Use ``clamp(<min>, <preferred>, <max>)`` for font sizes so
              text scales with resolution.
            • All styling MUST be inline (no external stylesheets).

            PAGINATION SYSTEM
            =================
            For elements that display lists (standings, results) you can
            enable automatic page cycling:

              "pagination": {{
                "enabled": true,
                "items_per_page": 10,
                "cycle_duration_seconds": 5
              }}

            In the template use:
              {{% for entry in frame.standings[page_start:page_end] %}}
            The render engine supplies ``page_start`` and ``page_end``
            automatically when pagination is enabled.

            SECTION CONTEXT
            ================
            This element belongs to the **{section}** section.

            REFERENCE EXAMPLES
            ===================
            Below are the DEFAULT elements shipped with the application.
            Study them to understand the exact syntax conventions.

            {ref_examples}

            ELEMENT TO MODIFY
            ===================
            Below is the CURRENT element you must modify.  Preserve its
            "id" field — do not rename it.

            {target_json}

            OTHER ELEMENTS IN THIS SECTION
            ================================
            {existing}

            CURRENT CSS VARIABLES (PRESET)
            ===============================
            {preset_vars}

            AVAILABLE ASSETS
            =================
            {available_assets}

            MODIFICATION GUIDELINES
            ========================
            • Preserve the element's "id" — it MUST stay the same.
            • Apply the user's requested change precisely.
            • Common requests and how to handle them:
              – "make it bigger"  → increase position.w / position.h.
              – "move it up/down" → adjust position.y.
              – "change colours"  → update CSS variable references or
                inline colour values.
              – "add team colours" → use {{{{ frame.team_color }}}} in
                appropriate style properties.
              – "show more drivers" → increase the loop slice count
                (e.g. standings[:8] → standings[:12]).
              – "add pagination"  → add pagination field and update the
                template to use page_start:page_end slicing.

            OUTPUT FORMAT
            ==============
            Return a single JSON object (no markdown fences, no extra text):

            {{
              "element": {{
                "id": "{target.get('id', 'element_id')}",
                "name": "Human-Readable Name",
                "template": "<Jinja2 HTML string>",
                "position": {{ "x": <0-100>, "y": <0-100>, "w": <0-100>, "h": <0-100> }},
                "z_index": <0-100>,
                "visible": true,
                "pagination": {{
                  "enabled": <bool>,
                  "items_per_page": <int>,
                  "cycle_duration_seconds": <float>
                }}
              }},
              "explanation": "Brief description of what was changed."
            }}

            The "pagination" field is optional — include only when relevant.

            RULES
            =====
            1. The template MUST use ONLY documented template variables
               (frame.*, pos.*, vars.*).
            2. The template MUST use CSS variables for theming
               (var(--color-*), var(--font-*)).
            3. The template MUST use clamp() for font sizes.
            4. All styling MUST be inline — no <style> blocks or external CSS.
            5. Position values must be 0–100.
            6. z_index must be 0–100.
            7. Do NOT add position:absolute in the template — the wrapper
               div handles positioning.
            8. The returned "id" MUST equal "{target.get('id', 'element_id')}".
        """)

    # ── schema ──────────────────────────────────────────────────────────

    def get_response_schema(self) -> dict:
        # Same schema as OverlayDesignSkill
        return OverlayDesignSkill.get_response_schema(self)

    # ── validation ──────────────────────────────────────────────────────

    def validate_output(self, output: dict) -> tuple[bool, str]:
        if "element" not in output:
            logger.warning("[OverlayAugmentSkill] validation failed: Missing 'element' key")
            return False, "Missing 'element' key."
        if "explanation" not in output:
            logger.warning("[OverlayAugmentSkill] validation failed: Missing 'explanation' key")
            return False, "Missing 'explanation' key."

        el = output["element"]
        if not isinstance(el, dict):
            logger.warning("[OverlayAugmentSkill] validation failed: 'element' is not an object")
            return False, "'element' must be an object."

        for key in ("id", "name", "template", "position", "z_index", "visible"):
            if key not in el:
                logger.warning("[OverlayAugmentSkill] validation failed: missing field '%s'", key)
                return False, f"element missing required field '{key}'."

        ok, msg = _validate_element_fields(el)
        if ok:
            logger.info("[OverlayAugmentSkill] validation passed: element '%s'", el.get("id"))
        else:
            logger.warning("[OverlayAugmentSkill] validation failed: %s", msg)
        return ok, msg


# ═══════════════════════════════════════════════════════════════════════════
#  Shared element validation
# ═══════════════════════════════════════════════════════════════════════════


def _validate_element_fields(el: dict) -> tuple[bool, str]:
    """Validate common element fields shared by overlay skills."""
    # id
    eid = el.get("id", "")
    if not isinstance(eid, str) or not _SAFE_ID_RE.match(eid):
        return False, (
            f"element.id '{eid}' must be alphanumeric with underscores "
            f"or hyphens only."
        )

    # template
    tpl = el.get("template", "")
    if not isinstance(tpl, str) or not tpl.strip():
        return False, "element.template must be a non-empty string."

    # position
    pos = el.get("position")
    if not isinstance(pos, dict):
        return False, "element.position must be an object."
    for axis in ("x", "y", "w", "h"):
        val = pos.get(axis)
        if not isinstance(val, (int, float)):
            return False, f"element.position.{axis} must be a number."
        if val < 0 or val > 100:
            return False, (
                f"element.position.{axis} = {val} is out of range 0–100."
            )

    # z_index
    z = el.get("z_index")
    if not isinstance(z, (int, float)):
        return False, "element.z_index must be a number."
    if z < 0 or z > 100:
        return False, f"element.z_index = {z} is out of range 0–100."

    # visible
    if not isinstance(el.get("visible"), bool):
        return False, "element.visible must be a boolean."

    # pagination (optional)
    if "pagination" in el:
        pag = el["pagination"]
        if not isinstance(pag, dict):
            return False, "element.pagination must be an object."
        if "enabled" in pag and not isinstance(pag["enabled"], bool):
            return False, "element.pagination.enabled must be a boolean."
        if "items_per_page" in pag:
            ipp = pag["items_per_page"]
            if not isinstance(ipp, int) or ipp < 1:
                return False, (
                    "element.pagination.items_per_page must be a "
                    "positive integer."
                )
        if "cycle_duration_seconds" in pag:
            cds = pag["cycle_duration_seconds"]
            if not isinstance(cds, (int, float)) or cds <= 0:
                return False, (
                    "element.pagination.cycle_duration_seconds must be "
                    "a positive number."
                )

    return True, ""


# ═══════════════════════════════════════════════════════════════════════════
#  Registration
# ═══════════════════════════════════════════════════════════════════════════


def register_default_skills():
    """Register all built-in LLM skills with the service."""
    from server.services.llm_service import llm_service

    llm_service.register_skill(EditorialSkill())
    llm_service.register_skill(OverlayDesignSkill())
    llm_service.register_skill(OverlayAugmentSkill())
