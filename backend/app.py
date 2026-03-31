"""
app.py — League Replay Studio entry point
-------------------------------------------
Creates the FastAPI app, registers routes, serves the React SPA,
and launches a pywebview native desktop window.

Usage:
  python app.py                  → GUI mode (pywebview window)
  WEB_ONLY=1 python app.py      → Browser mode (opens in default browser)
"""

import logging
import os
import sys
import threading
import traceback
from pathlib import Path

# ── Logging setup (before any other imports) ─────────────────────────────────
from server.config import APP_DIR, LOG_DIR
from server.utils.logging_config import setup_logging

setup_logging(LOG_DIR)

logger = logging.getLogger("league_replay_studio")
logger.info("=" * 60)
logger.info("[App] League Replay Studio starting up")
logger.info("[App] APP_DIR: %s", APP_DIR)

# ── Imports ──────────────────────────────────────────────────────────────────
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from version import __version__, APP_NAME
from server.config import STATIC_DIR, BUNDLE_DIR, CONFIG_PATH, ensure_directories, load_config, save_config, DEFAULT_CONFIG
from server.events import EventCategory, get_category

# Routes
from server.routes.api_settings import router as settings_router
from server.routes.api_system import router as system_router
from server.routes.api_iracing import router as iracing_router
from server.routes.api_projects import router as projects_router

# Services
from server.services.iracing_bridge import bridge as iracing_bridge

logger.info("[App] All imports OK")

# ── WebSocket connection manager ─────────────────────────────────────────────

class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("[WebSocket] Client connected (%d total)", len(self.active_connections))

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.remove(websocket)
        logger.info("[WebSocket] Client disconnected (%d total)", len(self.active_connections))

    async def broadcast(self, message: dict) -> None:
        """Send a message to all connected clients."""
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                pass


ws_manager = ConnectionManager()

# ── FastAPI app ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown lifecycle."""
    ensure_directories()

    # Write default config on first run
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        logger.info("[App] Created default config.json")

    # ── Start iRacing bridge ────────────────────────────────────────────────
    loop = asyncio.get_event_loop()

    async def _broadcast_iracing(message: dict) -> None:
        await ws_manager.broadcast(message)

    def _on_iracing_update(message: dict) -> None:
        """Called from the bridge's poll thread — schedule broadcast on the loop."""
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _broadcast_iracing(message), loop
            )

    iracing_bridge.on_update = _on_iracing_update
    iracing_bridge.start(loop)
    logger.info("[App] iRacing bridge started")

    logger.info("[App] Startup complete — v%s", __version__)
    yield

    # ── Shutdown ────────────────────────────────────────────────────────────
    iracing_bridge.stop()
    logger.info("[App] Shutting down")


app = FastAPI(
    title=APP_NAME,
    version=__version__,
    lifespan=lifespan,
)

# CORS for local development (Vite dev server on port 3174)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3174", "http://127.0.0.1:3174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Register routers ────────────────────────────────────────────────────────
app.include_router(settings_router)
app.include_router(system_router)
app.include_router(iracing_router)
app.include_router(projects_router)


# ── WebSocket endpoint ──────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint for real-time communication.

    Incoming messages are routed by event category to the appropriate handler.
    Unknown categories are logged and ignored.
    """
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event", "")
            payload = data.get("data", {})
            category = get_category(event)
            logger.info("[WebSocket] Received: %s (category=%s)", event, category)

            # ── Route by category ──────────────────────────────────────────
            if category == EventCategory.IRACING:
                await _handle_iracing_event(event, payload, websocket)
            elif category == EventCategory.SYSTEM:
                await _handle_system_event(event, payload, websocket)
            else:
                logger.debug("[WebSocket] No handler for category: %s", category)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as exc:
        logger.error("[WebSocket] Error: %s", exc)
        ws_manager.disconnect(websocket)


async def _handle_iracing_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming iRacing-related events from the frontend."""
    if event == "iracing:request_status":
        # Client requests current iRacing connection status
        await websocket.send_json({
            "event": "iracing:connected" if iracing_bridge.is_connected else "iracing:disconnected",
            "data": iracing_bridge.session_data if iracing_bridge.is_connected else {},
        })
    else:
        logger.debug("[WebSocket] Unhandled iRacing event: %s", event)


async def _handle_system_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming system-related events from the frontend."""
    if event == "system:ping":
        await websocket.send_json({"event": "system:pong", "data": {}})
    else:
        logger.debug("[WebSocket] Unhandled system event: %s", event)


# ── SPA serving ──────────────────────────────────────────────────────────────

# Mount static assets (JS/CSS/images with content hashes)
if STATIC_DIR.exists() and (STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")


@app.get("/")
async def serve_index():
    """Serve the React SPA index page."""
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path), media_type="text/html")
    # During development, the frontend runs on Vite dev server
    return JSONResponse(
        {"message": "Frontend not built. Run: cd frontend && npm run build"},
        status_code=200,
    )


@app.get("/{path:path}")
async def serve_spa(path: str):
    """Serve static files or fall back to index.html for SPA routing."""
    # Try to serve the exact file
    full_path = STATIC_DIR / path
    if full_path.exists() and full_path.is_file():
        return FileResponse(str(full_path))
    # Fall back to index.html for SPA client-side routing
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path), media_type="text/html")
    return JSONResponse(
        {"message": "Frontend not built. Run: cd frontend && npm run build"},
        status_code=200,
    )


# ── Global error handler ────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Log unhandled exceptions and return a clean error response."""
    logger.error("[App] Unhandled exception:\n%s", traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"error": "internal_server_error", "message": str(exc)},
    )


# ── Icon helpers ─────────────────────────────────────────────────────────────

def _get_icon_path() -> str:
    """Return the path to the application icon."""
    for name in ("icon.ico", "icon.png"):
        icon = BUNDLE_DIR / name
        if icon.exists():
            return str(icon)
        # Also check project root
        icon = APP_DIR.parent / name
        if icon.exists():
            return str(icon)
    return ""


def _apply_app_user_model_id() -> None:
    """Set Windows AppUserModelID so taskbar shows our icon."""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "LeagueReplayStudio.App"
        )
        logger.info("[App] AppUserModelID set")
    except Exception as exc:
        logger.warning("[App] AppUserModelID failed: %s", exc)


# ── Server runner ────────────────────────────────────────────────────────────

def start_server(port: int = 6175) -> None:
    """Start the FastAPI server with uvicorn."""
    import uvicorn
    logger.info("[App] Starting FastAPI on http://127.0.0.1:%d", port)
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


# ── Main entry point ────────────────────────────────────────────────────────

def main() -> None:
    """Launch the application — pywebview window or browser."""
    port = int(os.environ.get("LRS_PORT", "6175"))
    web_only = os.environ.get("WEB_ONLY", "0") == "1"

    # Start FastAPI in background thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    url = f"http://127.0.0.1:{port}"

    if web_only:
        logger.info("[App] Launching in browser (web-only mode)")
        import webbrowser
        webbrowser.open(url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            logger.info("[App] Shutting down")
    else:
        try:
            import webview

            _apply_app_user_model_id()
            icon_path = _get_icon_path()

            if icon_path:
                os.environ["PYWEBVIEW_ICON"] = icon_path

            win = webview.create_window(
                title=f"{APP_NAME} v{__version__}",
                url=url,
                min_size=(1024, 700),
                resizable=True,
                text_select=True,
                maximized=True,
            )
            webview.start(private_mode=False)
        except ImportError:
            logger.warning("[App] pywebview not available — falling back to browser")
            import webbrowser
            webbrowser.open(url)
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                logger.info("[App] Shutting down")
        except Exception:
            logger.exception("[App] pywebview failed — falling back to browser")
            import webbrowser
            webbrowser.open(url)
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                logger.info("[App] Shutting down")


if __name__ == "__main__":
    main()
