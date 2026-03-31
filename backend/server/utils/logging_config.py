"""
logging_config.py
------------------
Structured logging setup for League Replay Studio.
"""

import logging
import sys
from pathlib import Path


def setup_logging(log_dir: Path, level: int = logging.INFO) -> None:
    """Configure application-wide logging with file and console handlers."""
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

    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))

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
