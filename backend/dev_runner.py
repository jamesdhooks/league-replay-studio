"""Supervised development runner for League Replay Studio.

Starts frontend (Vite HMR) and backend (Uvicorn --reload) under one parent
process so Ctrl+C and failures cleanly tear down both process trees.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 6369
FRONTEND_HOST = "127.0.0.1"
FRONTEND_PORT = 5299

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"


def _is_port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) == 0


def _wait_for_port(host: str, port: int, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if _is_port_open(host, port):
            return True
        time.sleep(0.2)
    return False


def _terminate_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return

    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass


def _spawn(name: str, args: list[str], cwd: Path) -> subprocess.Popen:
    creationflags = 0
    preexec_fn = None

    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        preexec_fn = os.setsid

    print(f"[dev-runner] Starting {name}: {' '.join(args)}")
    return subprocess.Popen(
        args,
        cwd=str(cwd),
        creationflags=creationflags,
        preexec_fn=preexec_fn,
    )


def main() -> int:
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"

    frontend_cmd = [
        npm_cmd,
        "run",
        "dev",
        "--",
        "--host",
        FRONTEND_HOST,
        "--port",
        str(FRONTEND_PORT),
        "--strictPort",
    ]

    backend_cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "app:app",
        "--host",
        BACKEND_HOST,
        "--port",
        str(BACKEND_PORT),
        "--reload",
        "--reload-dir",
        str(BACKEND_DIR),
        "--log-level",
        "warning",
    ]

    processes: list[tuple[str, subprocess.Popen]] = []

    try:
        frontend = _spawn("frontend", frontend_cmd, FRONTEND_DIR)
        processes.append(("frontend", frontend))

        backend = _spawn("backend", backend_cmd, BACKEND_DIR)
        processes.append(("backend", backend))

        frontend_up = _wait_for_port(FRONTEND_HOST, FRONTEND_PORT, timeout_seconds=20)
        backend_up = _wait_for_port(BACKEND_HOST, BACKEND_PORT, timeout_seconds=20)

        if frontend_up:
            frontend_url = f"http://{FRONTEND_HOST}:{FRONTEND_PORT}"
            print(f"[dev-runner] Opening browser: {frontend_url}")
            webbrowser.open(frontend_url)
        else:
            print("[dev-runner] Frontend did not start in time; browser not opened.")

        if not backend_up:
            print("[dev-runner] Backend did not bind in time (still watching for restart loops).")

        print("[dev-runner] Dev mode running. Press Ctrl+C to stop both servers.")

        while True:
            for name, proc in processes:
                code = proc.poll()
                if code is not None:
                    print(f"[dev-runner] {name} exited with code {code}; shutting down.")
                    return code
            time.sleep(0.3)

    except KeyboardInterrupt:
        print("\n[dev-runner] Ctrl+C received; shutting down process trees...")
        return 0
    finally:
        for _, proc in reversed(processes):
            _terminate_process_tree(proc)


if __name__ == "__main__":
    raise SystemExit(main())
