"""
events.py
---------
Typed event system for WebSocket communication.

Defines event categories, types, and helper functions for the
real-time event system used between backend and frontend.

Event naming convention:  ``<category>:<action>``
Examples:
    iracing:connected, iracing:disconnected, iracing:session_info,
    pipeline:step_completed, encoding:progress, system:settings_changed
"""

from __future__ import annotations

from typing import Any


# ── Event Categories ─────────────────────────────────────────────────────────

class EventCategory:
    """Known event category prefixes."""
    IRACING = "iracing"
    PIPELINE = "pipeline"
    ENCODING = "encoding"
    CAPTURE = "capture"
    PREVIEW = "preview"
    OVERLAY = "overlay"
    PROJECT = "project"
    SYSTEM = "system"

    ALL: list[str] = [
        "iracing", "pipeline", "encoding", "capture", "preview", "overlay", "project", "system"
    ]


# ── Concrete Event Types ─────────────────────────────────────────────────────

class EventType:
    """Typed event name constants."""

    # iRacing
    IRACING_CONNECTED      = "iracing:connected"
    IRACING_DISCONNECTED   = "iracing:disconnected"
    IRACING_SESSION_INFO   = "iracing:session_info"
    IRACING_TELEMETRY      = "iracing:telemetry"

    # Pipeline / Analysis
    PIPELINE_STARTED       = "pipeline:started"
    PIPELINE_STEP_COMPLETED = "pipeline:step_completed"
    PIPELINE_COMPLETED     = "pipeline:completed"
    PIPELINE_ERROR         = "pipeline:error"

    # Analysis-specific (sub-events of pipeline)
    ANALYSIS_STARTED       = "pipeline:started"       # stage=analysis
    ANALYSIS_PROGRESS      = "pipeline:step_completed" # stage=analysis_scan
    ANALYSIS_DETECT        = "pipeline:step_completed" # stage=analysis_detect
    ANALYSIS_COMPLETED     = "pipeline:completed"      # stage=analysis
    ANALYSIS_ERROR         = "pipeline:error"          # stage=analysis

    # Encoding (future)
    ENCODING_STARTED       = "encoding:started"
    ENCODING_PROGRESS      = "encoding:progress"
    ENCODING_COMPLETED     = "encoding:completed"
    ENCODING_ERROR         = "encoding:error"

    # Capture (future)
    CAPTURE_STARTED        = "capture:started"
    CAPTURE_STOPPED        = "capture:stopped"
    CAPTURE_PROGRESS       = "capture:progress"
    CAPTURE_FILE_DETECTED  = "capture:file_detected"
    CAPTURE_HOTKEY_TEST    = "capture:hotkey_test"
    CAPTURE_VALIDATED      = "capture:validated"
    CAPTURE_ERROR          = "capture:error"

    # Preview
    PREVIEW_PROGRESS       = "preview:progress"
    PREVIEW_TIER_READY     = "preview:tier_ready"
    PREVIEW_READY          = "preview:ready"
    PREVIEW_ERROR          = "preview:error"

    # Overlay
    OVERLAY_RENDER_STARTED    = "overlay:render_started"
    OVERLAY_RENDER_PROGRESS   = "overlay:render_progress"
    OVERLAY_RENDER_COMPLETED  = "overlay:render_completed"
    OVERLAY_ERROR             = "overlay:error"

    # Project
    PROJECT_UPDATED        = "project:updated"
    PROJECT_STEP_CHANGED   = "project:step_changed"

    # System
    SYSTEM_SETTINGS_CHANGED = "system:settings_changed"


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_event(event: str, data: dict[str, Any] | None = None) -> dict:
    """Build a consistently-shaped WebSocket event message.

    Args:
        event: Event type string (e.g., ``EventType.IRACING_CONNECTED``).
        data: Payload dict (defaults to empty dict).

    Returns:
        ``{"event": "<type>", "data": {...}}``
    """
    return {"event": event, "data": data or {}}


def get_category(event: str) -> str:
    """Extract the category prefix from an event string.

    >>> get_category("iracing:connected")
    'iracing'
    >>> get_category("unknown")
    'unknown'
    """
    return event.split(":")[0] if ":" in event else event
