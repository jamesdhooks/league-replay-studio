"""
logging_config.py
------------------
Structured logging setup for League Replay Studio.

Features
~~~~~~~~
- Dual output: file (detailed) + console (concise)
- Automatic log rotation when file exceeds 1 MB
- JSON-structured file logging for machine parsing
- Error categorization for systematic issue tracking
- Noisy library suppression (uvicorn, watchfiles)

Error Categories
~~~~~~~~~~~~~~~~
Log messages should include a category tag for filtering:

- ``[CAPTURE]``  — Screen capture, OBS, recording
- ``[ANALYSIS]`` — Event detection, replay analysis
- ``[SCORING]``  — Highlight scoring, timeline allocation
- ``[OVERLAY]``  — Overlay rendering, compositing
- ``[ENCODING]`` — Video export, FFmpeg encoding
- ``[IRACING]``  — iRacing SDK, telemetry, bridge
- ``[LLM]``      — AI/LLM provider communication
- ``[SETTINGS]`` — Configuration load/save
- ``[NETWORK]``  — API calls, WebSocket connections
- ``[UI]``       — Frontend-reported errors (via API)

Usage:
    logger.error("[CAPTURE] OBS connection lost: %s", err)
    logger.info("[SCORING] Generated %d highlights in %.2fs", count, elapsed)
"""

import json
import logging
import sys
from pathlib import Path


class StructuredFormatter(logging.Formatter):
    """JSON-structured log formatter for file output.

    Produces one JSON object per line for easy parsing by log analysis tools.
    """

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "ts": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "category"):
            log_entry["category"] = record.category
        return json.dumps(log_entry, ensure_ascii=False)


def setup_logging(log_dir: Path, level: int = logging.INFO) -> None:
    """Configure application-wide logging with file and console handlers.

    Args:
        log_dir: Directory to store log files.
        level: Minimum log level (default: INFO).
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "app.log"

    # Truncate log if too large (> 1 MB) — keep last 50 KB
    max_bytes = 1_000_000
    if log_path.exists() and log_path.stat().st_size > max_bytes:
        try:
            tail = log_path.read_bytes()[-50_000:]
            log_path.write_bytes(tail)
        except OSError:
            pass

    # File handler: JSON-structured for machine parsing
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(StructuredFormatter(
        datefmt="%Y-%m-%d %H:%M:%S",
    ))

    # Console handler: human-readable
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    ))

    logging.basicConfig(
        level=level,
        handlers=[file_handler, console_handler],
    )

    # Quiet down noisy libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("watchfiles").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
