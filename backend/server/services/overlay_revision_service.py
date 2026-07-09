"""
overlay_revision_service.py
---------------------------
Revision snapshots for Overlay Studio HTML edits.

Each revision captures the preset metadata and HTML that existed immediately
before a save or restore.  The current preset remains the source of truth; the
revision directory is only a rollback ledger.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from server.services import preset_service as preset_module


def html_sha256(html_content: str) -> str:
    """Return the SHA-256 hash used for optimistic overlay HTML writes."""
    return hashlib.sha256((html_content or "").encode("utf-8")).hexdigest()


class OverlayRevisionService:
    """Manages per-design overlay HTML revision snapshots."""

    def _preset_dir(self, preset_id: str) -> Path:
        safe_id = preset_module._safe_id(preset_id)
        return preset_module.PRESETS_DIR / safe_id

    def _revision_dir(self, preset_id: str, revision_id: str) -> Path:
        safe_revision_id = preset_module._safe_id(revision_id)
        return self._preset_dir(preset_id) / "revisions" / safe_revision_id

    def create_revision(
        self,
        preset_id: str,
        *,
        previous_html: str,
        result_html: str,
        author: str = "user",
        source: str = "ui",
        summary: str = "",
    ) -> dict[str, Any]:
        """Snapshot the current preset files before replacing them."""
        safe_id = preset_module._safe_id(preset_id)
        preset_dir = self._preset_dir(safe_id)
        revisions_dir = preset_dir / "revisions"
        revisions_dir.mkdir(parents=True, exist_ok=True)

        revision_id = f"rev_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
        revision_dir = revisions_dir / revision_id
        revision_dir.mkdir(parents=True, exist_ok=False)

        preset_json = preset_dir / "preset.json"
        overlay_html = preset_dir / "overlay.html"
        if preset_json.exists():
            shutil.copy2(preset_json, revision_dir / "preset.json")
        if overlay_html.exists():
            shutil.copy2(overlay_html, revision_dir / "overlay.html")
        else:
            (revision_dir / "overlay.html").write_text(previous_html or "", encoding="utf-8")

        metadata = {
            "revision_id": revision_id,
            "preset_id": safe_id,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "author": (author or "user").strip()[:80],
            "source": (source or "ui").strip()[:40],
            "summary": (summary or "").strip()[:300],
            "base_sha256": html_sha256(previous_html),
            "result_sha256": html_sha256(result_html),
        }
        (revision_dir / "metadata.json").write_text(
            json.dumps(metadata, indent=2),
            encoding="utf-8",
        )
        return metadata

    def list_revisions(self, preset_id: str) -> list[dict[str, Any]]:
        """Return revision metadata newest-first."""
        revisions_dir = self._preset_dir(preset_id) / "revisions"
        if not revisions_dir.exists():
            return []

        revisions: list[dict[str, Any]] = []
        for meta_path in revisions_dir.glob("*/metadata.json"):
            try:
                metadata = json.loads(meta_path.read_text(encoding="utf-8"))
                revisions.append(metadata)
            except (json.JSONDecodeError, OSError):
                continue

        revisions.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
        return revisions

    def get_revision(self, preset_id: str, revision_id: str, include_html: bool = True) -> dict[str, Any] | None:
        """Return one revision metadata payload, optionally with HTML content."""
        revision_dir = self._revision_dir(preset_id, revision_id)
        meta_path = revision_dir / "metadata.json"
        if not meta_path.exists():
            return None

        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

        if include_html:
            html_path = revision_dir / "overlay.html"
            metadata["html_content"] = html_path.read_text(encoding="utf-8") if html_path.exists() else ""
        return metadata


overlay_revision_service = OverlayRevisionService()
