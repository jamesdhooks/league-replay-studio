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
from server.routes.api_analysis import router as analysis_router, set_broadcast_fn
from server.routes.api_capture import router as capture_router
from server.routes.api_encoding import router as encoding_router
from server.routes.api_preview import router as preview_router
from server.routes.api_overlay import router as overlay_router
from server.routes.api_preset import router as preset_router
from server.routes.api_youtube import router as youtube_router
from server.routes.api_pipeline import router as pipeline_router
from server.utils.command_log import command_log
from server.routes.api_wizard import router as wizard_router
from server.routes.api_llm import router as llm_router
from server.routes.api_collection import router as collection_router
from server.routes.api_composition import router as composition_router
from server.routes.api_script_state import router as script_state_router
from server.routes.api_data_plugins import router as data_plugins_router

# Services
from server.services.iracing_bridge import bridge as iracing_bridge
from server.services.capture_service import capture_service
from server.services.encoding_service import encoding_service
from server.services.preview_service import preview_service
from server.services.overlay_service import overlay_service
from server.services.youtube_service import youtube_service
from server.services.pipeline_service import pipeline_service

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
                logger.warning("[WebSocket] Failed to broadcast to a client")


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

    # ── Wire analysis broadcast ─────────────────────────────────────────────
    def _analysis_broadcast(message: dict) -> None:
        """Broadcast analysis progress events via WebSocket."""
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(ws_manager.broadcast(message), loop)

    set_broadcast_fn(_analysis_broadcast)

    # ── Wire capture service ───────────────────────────────────────────────
    capture_service.set_loop(loop)

    async def _broadcast_capture(message: dict) -> None:
        await ws_manager.broadcast(message)

    capture_service.set_broadcast_fn(_broadcast_capture)

    # ── Wire encoding service ──────────────────────────────────────────────
    encoding_service.set_loop(loop)

    async def _broadcast_encoding(message: dict) -> None:
        await ws_manager.broadcast(message)

    encoding_service.set_broadcast_fn(_broadcast_encoding)

    # ── Wire preview service ───────────────────────────────────────────────
    preview_service.set_loop(loop)

    async def _broadcast_preview(message: dict) -> None:
        await ws_manager.broadcast(message)

    preview_service.set_broadcast_fn(_broadcast_preview)

    # ── Wire overlay service ──────────────────────────────────────────────
    overlay_service.set_loop(loop)

    async def _broadcast_overlay(message: dict) -> None:
        await ws_manager.broadcast(message)

    overlay_service.set_broadcast_fn(_broadcast_overlay)

    # ── Wire youtube service ─────────────────────────────────────────────
    youtube_service.set_loop(loop)

    async def _broadcast_youtube(message: dict) -> None:
        await ws_manager.broadcast(message)

    youtube_service.set_broadcast_fn(_broadcast_youtube)

    # ── Wire pipeline service ────────────────────────────────────────────
    pipeline_service.set_loop(loop)

    async def _broadcast_pipeline(message: dict) -> None:
        await ws_manager.broadcast(message)

    pipeline_service.set_broadcast_fn(_broadcast_pipeline)

    # ── Register LLM skills ─────────────────────────────────────────────────
    from server.services.llm_skills import register_default_skills
    register_default_skills()
    logger.info("[App] LLM skills registered")
    # ── Wire command log broadcast ────────────────────────────────────────
    def _command_log_broadcast(message: dict) -> None:
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(ws_manager.broadcast(message), loop)

    command_log.set_broadcast_fn(_command_log_broadcast)
    # ── Background update check ──────────────────────────────────────────────
    from server.services.update_service import update_service
    asyncio.create_task(update_service.startup_check(delay=10.0))

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

# CORS for local development (Vite dev server on port 3189)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3189", "http://127.0.0.1:3189"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Register routers ────────────────────────────────────────────────────────
app.include_router(settings_router)
app.include_router(system_router)
app.include_router(iracing_router)
app.include_router(projects_router)
app.include_router(analysis_router)
app.include_router(capture_router)
app.include_router(encoding_router)
app.include_router(preview_router)
app.include_router(overlay_router)
app.include_router(preset_router)
app.include_router(youtube_router)
app.include_router(pipeline_router)
app.include_router(wizard_router)
app.include_router(llm_router)
app.include_router(collection_router)
app.include_router(composition_router)
app.include_router(script_state_router)
app.include_router(data_plugins_router)


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
            elif category == EventCategory.CAPTURE:
                await _handle_capture_event(event, payload, websocket)
            elif category == EventCategory.ENCODING:
                await _handle_encoding_event(event, payload, websocket)
            elif category == EventCategory.PREVIEW:
                await _handle_preview_event(event, payload, websocket)
            elif category == EventCategory.OVERLAY:
                await _handle_overlay_event(event, payload, websocket)
            elif category == EventCategory.YOUTUBE:
                await _handle_youtube_event(event, payload, websocket)
            elif category == EventCategory.AUTOMATION:
                await _handle_pipeline_event(event, payload, websocket)
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


async def _handle_capture_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming capture-related events from the frontend."""
    if event == "capture:request_status":
        await websocket.send_json({
            "event": "capture:status",
            "data": capture_service.status,
        })
    else:
        logger.debug("[WebSocket] Unhandled capture event: %s", event)


async def _handle_encoding_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming encoding-related events from the frontend."""
    if event == "encoding:request_status":
        await websocket.send_json({
            "event": "encoding:status",
            "data": encoding_service.status,
        })
    else:
        logger.debug("[WebSocket] Unhandled encoding event: %s", event)


async def _handle_preview_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming preview-related events from the frontend."""
    if event == "preview:request_status":
        await websocket.send_json({
            "event": "preview:status",
            "data": preview_service.status,
        })
    else:
        logger.debug("[WebSocket] Unhandled preview event: %s", event)


async def _handle_overlay_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming overlay-related events from the frontend."""
    if event == "overlay:request_status":
        await websocket.send_json({
            "event": "overlay:status",
            "data": overlay_service.status,
        })
    else:
        logger.debug("[WebSocket] Unhandled overlay event: %s", event)


async def _handle_youtube_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming YouTube-related events from the frontend."""
    if event == "youtube:request_status":
        status = await youtube_service.get_connection_status()
        await websocket.send_json({
            "event": "youtube:status",
            "data": status,
        })
    elif event == "youtube:request_upload_status":
        await websocket.send_json({
            "event": "youtube:upload_status",
            "data": youtube_service.get_upload_status(),
        })
    else:
        logger.debug("[WebSocket] Unhandled YouTube event: %s", event)


async def _handle_pipeline_event(event: str, payload: dict, websocket: WebSocket) -> None:
    """Handle incoming pipeline-related events from the frontend."""
    if event == "automation:request_status":
        await websocket.send_json({
            "event": "automation:status",
            "data": pipeline_service.status,
        })
    else:
        logger.debug("[WebSocket] Unhandled pipeline event: %s", event)


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
    """Serve static files or fall back to index.html for SPA routing.

    Excludes /api and /ws paths — those are handled by registered routers.
    """
    # Never intercept API or WebSocket paths
    if path.startswith("api/") or path.startswith("ws"):
        return JSONResponse(
            {"error": "not_found", "message": f"No route: /{path}"},
            status_code=404,
        )
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
    for name in ("icon.ico", "icon.png", "icon.svg"):
        # Check next to the executable / bundle root
        icon = BUNDLE_DIR / name
        if icon.exists():
            return str(icon)
        # Check inside the built static dir (Vite public assets)
        icon = STATIC_DIR / name
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

def start_server(port: int = 6177, reload_enabled: bool = False) -> None:
    """Start the FastAPI server with uvicorn."""
    import uvicorn
    logger.info("[App] Starting FastAPI on http://127.0.0.1:%d (reload=%s)", port, reload_enabled)
    if reload_enabled:
        # Uvicorn reload mode requires an import string and should run on main thread.
        uvicorn.run(
            "app:app",
            host="127.0.0.1",
            port=port,
            log_level="warning",
            reload=True,
        )
    else:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
        )


# ── Main entry point ────────────────────────────────────────────────────────

def main() -> None:
    """Launch the application — pywebview window or browser."""
    port = int(os.environ.get("LRS_PORT", "6177"))
    argv = sys.argv[1:]
    web_only = (os.environ.get("WEB_ONLY", "0") == "1") or ("--web" in argv)
    reload_requested = (os.environ.get("LRS_RELOAD", "0") == "1") or ("--reload" in argv)

    # Reload is intended for browser/web mode only.
    reload_enabled = reload_requested and web_only
    if reload_requested and not web_only:
        logger.warning("[App] --reload ignored because app is not in --web mode")

    url = f"http://127.0.0.1:{port}"
    frontend_url = os.environ.get("LRS_FRONTEND_URL", "").strip() or url

    if web_only and reload_enabled:
        logger.info("[App] Launching in browser with hot reload (%s)", frontend_url)
        import webbrowser

        # Open browser shortly after server boot starts.
        threading.Timer(1.0, lambda: webbrowser.open(frontend_url)).start()
        start_server(port=port, reload_enabled=True)
        return

    # Start FastAPI in background thread
    server_thread = threading.Thread(target=start_server, kwargs={"port": port, "reload_enabled": False}, daemon=True)
    server_thread.start()

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
    # ── CLI mode detection ──────────────────────────────────────────────────
    # If any recognized CLI flags are present, route to the headless CLI
    # instead of starting FastAPI + pywebview.
    _cli_flags = {
        "--project", "--highlights", "--full-race", "--analyse-only",
        "--full-pipeline", "--preset", "--output", "--upload",
        "--gpu", "-v", "--verbose", "-q", "--quiet",
    }
    if any(arg in _cli_flags or arg.startswith(("--project=", "--preset=", "--output=", "--gpu="))
           for arg in sys.argv[1:]):
        try:
            from cli import main as cli_main
            sys.exit(cli_main())
        except SystemExit:
            raise
        except Exception as _cli_exc:
            print(f"ERROR: CLI failed: {_cli_exc}", file=sys.stderr)
            sys.exit(1)
    # ── GUI mode ─────────────────────────────────────────────────────────────
    main()
