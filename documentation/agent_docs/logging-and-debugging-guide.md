# Logging and Debugging Guide

## Overview

Logging conventions for League Replay Studio. Essential information only — no verbose debug traces.

## Core Principles

1. **Essential Information Only** — Log what's needed for debugging, not execution traces
2. **Errors and Warnings First** — Focus on failures, not success paths
3. **No Verbose Debug Logging** — Avoid step-by-step traces in production code
4. **Context is Key** — Always include relevant context using standardised prefixes

## What to Log (and What Not to Log)

### ✅ DO Log

**Errors (always):**
- Critical failures that prevent functionality
- External service failures (iRacing SDK, FFmpeg, YouTube API)
- Database errors
- File I/O errors (missing replay files, encoding failures)

**Warnings:**
- Missing or incomplete data
- Fallback behaviour activation (CPU encoding when no GPU)
- Configuration issues
- Network interruptions during YouTube upload

**Info (major milestones only):**
- Service startup/shutdown
- Analysis complete (with summary: "12 events detected in 23s")
- Encoding complete (with summary: "45min race → 1.2GB in 3m12s")
- Pipeline step transitions

### ❌ DON'T Log

```python
# ❌ Too verbose
logger.debug("Starting analysis...")
logger.debug(f"Processing frame {frame_num}")
logger.debug(f"Checking car {car_idx}")
logger.debug(f"Distance: {distance}")
logger.debug("No incident detected")

# ✅ Better — log only outcomes
# (No logging for normal operation)
# Only log if there's an issue:
if not connected:
    logger.warning("[iRacing] Connection lost during analysis at frame %d", frame_num)
```

## Prefix Format

All logging uses a standardised prefix: `[Context] Message`

### Backend Prefixes

| Prefix | Domain |
|--------|--------|
| `[App]` | Application lifecycle (startup, shutdown) |
| `[API]` | Route handler issues |
| `[iRacing]` | iRacing SDK interactions |
| `[Analysis]` | Replay analysis engine |
| `[Detector]` | Event detectors (incident, battle, etc.) |
| `[Encoding]` | FFmpeg encoding operations |
| `[Preview]` | Video preview / asset pipeline |
| `[Overlay]` | Playwright overlay rendering |
| `[Capture]` | OBS/ShadowPlay capture |
| `[YouTube]` | YouTube API operations |
| `[Pipeline]` | Automated pipeline execution |
| `[Settings]` | Configuration management |
| `[DB]` | Database operations |
| `[WebSocket]` | WebSocket connections and messages |

### Frontend Prefixes

| Prefix | Domain |
|--------|--------|
| `[API]` | API calls and responses |
| `[WebSocket]` | WebSocket connection and messages |
| `[Context]` | React context operations |
| `[Hook]` | Custom hook issues |
| `[Service]` | Service layer operations |

## Python Logging Setup

```python
import logging

logger = logging.getLogger(__name__)

# Module-level usage
logger.info("[iRacing] Connected to session: %s at %s", session_name, track_name)
logger.warning("[Encoding] No NVENC GPU detected — falling back to CPU encoding")
logger.error("[YouTube] Upload failed: %s (attempt %d/%d)", error_msg, attempt, max_retries)
```

## Log Levels

| Level | Use |
|-------|-----|
| `ERROR` | Something broke and needs attention |
| `WARNING` | Something unexpected but handled |
| `INFO` | Major milestone or state change |
| `DEBUG` | Only for active debugging sessions (disabled in production) |

## Best Practices

- Use `%s` formatting (not f-strings) in logger calls for lazy evaluation
- Include relevant IDs: project ID, car index, frame number
- Log durations for long operations: `"[Encoding] Complete in 3m12s"`
- Never log sensitive data (API keys, OAuth tokens)
- Log file stored at project root: `league-replay-studio.log`
- Rotate logs at 10MB, keep 3 backups
