"""Download and refresh Tailwind runtime used by built-in overlay templates.

This script vendors the CDN Tailwind runtime into:
    backend/server/templates/_shared/tailwind.runtime.js

Default behavior:
- Resolve latest Tailwind version from npm registry
- Download runtime JS from cdn.tailwindcss.com
- Write JS and metadata file atomically

Usage:
  python backend/scripts/update_overlay_tailwind.py
  python backend/scripts/update_overlay_tailwind.py --version 3.4.17
"""

from __future__ import annotations

import argparse
import json
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY_URL = "https://registry.npmjs.org/tailwindcss/latest"
RUNTIME_URL = "https://cdn.tailwindcss.com"

ROOT = Path(__file__).resolve().parents[2]
TARGET_RUNTIME = ROOT / "backend" / "server" / "templates" / "_shared" / "tailwind.runtime.js"
TARGET_META = ROOT / "backend" / "server" / "templates" / "_shared" / "tailwind.version.json"


def _http_get_text(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "lrs-tailwind-updater/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:  # noqa: S310
        return response.read().decode("utf-8")


def resolve_latest_version() -> str:
    payload = _http_get_text(REGISTRY_URL)
    data = json.loads(payload)
    version = str(data.get("version", "")).strip()
    if not version:
        raise RuntimeError("Could not resolve latest tailwindcss version from npm registry")
    return version


def download_tailwind_runtime() -> str:
    script = _http_get_text(RUNTIME_URL)
    if not script or "tailwind" not in script.lower():
        raise RuntimeError("Downloaded Tailwind runtime script looked invalid")
    return script


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Update vendored Tailwind CSS for overlay templates")
    parser.add_argument("--version", help="Tailwind version (defaults to latest)")
    args = parser.parse_args()

    try:
        version = args.version.strip() if args.version else resolve_latest_version()
        runtime = download_tailwind_runtime()

        write_atomic(TARGET_RUNTIME, runtime)
        meta = {
            "package": "tailwindcss",
            "version": version,
            "source": RUNTIME_URL,
        }
        write_atomic(TARGET_META, json.dumps(meta, indent=2) + "\n")

        print(f"Updated {TARGET_RUNTIME} to tailwindcss v{version}")
        return 0
    except urllib.error.URLError as exc:
        print(f"Network error while updating Tailwind CSS: {exc}")
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to update Tailwind CSS: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
