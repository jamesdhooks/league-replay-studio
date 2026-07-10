"""Minimal OBS WebSocket v5 client for reliable scripted recording control."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from typing import Any


class ObsWebSocketError(RuntimeError):
    """Raised when OBS WebSocket is unavailable or rejects a request."""


def build_obs_websocket_auth(password: str, salt: str, challenge: str) -> str:
    """Build the OBS WebSocket v5 authentication response."""
    secret = base64.b64encode(
        hashlib.sha256(f"{password}{salt}".encode("utf-8")).digest()
    ).decode("utf-8")
    return base64.b64encode(
        hashlib.sha256(f"{secret}{challenge}".encode("utf-8")).digest()
    ).decode("utf-8")


class ObsWebSocketClient:
    """Synchronous, small-surface client for OBS WebSocket protocol v5."""

    def __init__(self, host: str = "127.0.0.1", port: int = 4455, password: str = "") -> None:
        self.host = host or "127.0.0.1"
        self.port = int(port or 4455)
        self.password = password or ""
        self._socket: Any = None

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"

    def connect(self) -> None:
        try:
            from websockets.sync.client import connect
        except ImportError as exc:
            raise ObsWebSocketError("Python package 'websockets' is not installed") from exc

        try:
            self._socket = connect(self.url, open_timeout=3, close_timeout=2)
            hello = self._recv()
            if hello.get("op") != 0:
                raise ObsWebSocketError("OBS WebSocket did not send a Hello message")

            identify: dict[str, Any] = {"rpcVersion": 1}
            authentication = (hello.get("d") or {}).get("authentication") or {}
            if authentication:
                if not self.password:
                    raise ObsWebSocketError("OBS WebSocket requires a password; set it in Settings > Camera Defaults")
                identify["authentication"] = build_obs_websocket_auth(
                    self.password,
                    str(authentication.get("salt") or ""),
                    str(authentication.get("challenge") or ""),
                )

            self._send({"op": 1, "d": identify})
            identified = self._recv()
            if identified.get("op") != 2:
                detail = (identified.get("d") or {}).get("comment") or "OBS WebSocket identification failed"
                raise ObsWebSocketError(str(detail))
        except ObsWebSocketError:
            self.close()
            raise
        except Exception as exc:
            self.close()
            raise ObsWebSocketError(f"Cannot connect to OBS WebSocket at {self.url}: {exc}") from exc

    def close(self) -> None:
        if self._socket is not None:
            try:
                self._socket.close()
            except Exception:
                pass
        self._socket = None

    def request(self, request_type: str, request_data: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._socket is None:
            self.connect()
        request_id = uuid.uuid4().hex
        self._send({
            "op": 6,
            "d": {
                "requestType": request_type,
                "requestId": request_id,
                "requestData": request_data or {},
            },
        })
        while True:
            message = self._recv()
            if message.get("op") != 7 or (message.get("d") or {}).get("requestId") != request_id:
                continue
            data = message.get("d") or {}
            status = data.get("requestStatus") or {}
            if not status.get("result"):
                raise ObsWebSocketError(
                    str(status.get("comment") or f"OBS rejected {request_type} ({status.get('code', 'unknown')})")
                )
            return dict(data.get("responseData") or {})

    def get_record_status(self) -> dict[str, Any]:
        return self.request("GetRecordStatus")

    def wait_for_recording_state(self, expected_active: bool, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if bool(self.get_record_status().get("outputActive")) is expected_active:
                return True
            time.sleep(0.15)
        return False

    def _send(self, payload: dict[str, Any]) -> None:
        if self._socket is None:
            raise ObsWebSocketError("OBS WebSocket is not connected")
        self._socket.send(json.dumps(payload))

    def _recv(self) -> dict[str, Any]:
        if self._socket is None:
            raise ObsWebSocketError("OBS WebSocket is not connected")
        raw = self._socket.recv(timeout=5)
        try:
            return json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ObsWebSocketError("OBS WebSocket returned invalid JSON") from exc


def probe_obs_websocket(host: str = "127.0.0.1", port: int = 4455, password: str = "") -> dict[str, Any]:
    """Return OBS WebSocket availability and current recording state."""
    client = ObsWebSocketClient(host=host, port=port, password=password)
    try:
        client.connect()
        status = client.get_record_status()
        return {
            "available": True,
            "host": client.host,
            "port": client.port,
            "recording": bool(status.get("outputActive")),
            "reason": None,
        }
    except ObsWebSocketError as exc:
        return {
            "available": False,
            "host": client.host,
            "port": client.port,
            "recording": False,
            "reason": str(exc),
        }
    finally:
        client.close()
