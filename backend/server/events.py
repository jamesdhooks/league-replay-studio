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
    PROJECT = "project"
    SYSTEM = "system"

    ALL: list[str] = [
        "iracing", "pipeline", "encoding", "capture", "project", "system"
    ]


# ── Concrete Event Types ─────────────────────────────────────────────────────

class EventType:
    """Typed event name constants."""

    # iRacing
    IRACING_CONNECTED      = "iracing:connected"
    IRACING_DISCONNECTED   = "iracing:disconnected"
    IRACING_SESSION_INFO   = "iracing:session_info"
    IRACING_TELEMETRY      = "iracing:telemetry"

    # Pipeline (future)
    PIPELINE_STARTED       = "pipeline:started"
    PIPELINE_STEP_COMPLETED = "pipeline:step_completed"
    PIPELINE_COMPLETED     = "pipeline:completed"
    PIPELINE_ERROR         = "pipeline:error"

    # Encoding (future)
    ENCODING_STARTED       = "encoding:started"
    ENCODING_PROGRESS      = "encoding:progress"
    ENCODING_COMPLETED     = "encoding:completed"
    ENCODING_ERROR         = "encoding:error"

    # Capture (future)
    CAPTURE_STARTED        = "capture:started"
    CAPTURE_STOPPED        = "capture:stopped"
    CAPTURE_ERROR          = "capture:error"

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
