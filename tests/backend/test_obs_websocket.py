import base64
import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.utils.obs_websocket import build_obs_websocket_auth
from server.utils.script_capture import ObsWebSocketRecorderAdapter


def test_obs_websocket_auth_matches_protocol_hashing():
    password = "secret"
    salt = "salt"
    challenge = "challenge"
    secret = base64.b64encode(hashlib.sha256(f"{password}{salt}".encode("utf-8")).digest()).decode("utf-8")
    expected = base64.b64encode(hashlib.sha256(f"{secret}{challenge}".encode("utf-8")).digest()).decode("utf-8")

    assert build_obs_websocket_auth(password, salt, challenge) == expected


def test_obs_websocket_adapter_moves_authoritative_stop_output(tmp_path):
    source = tmp_path / "obs-output.mp4"
    source.write_bytes(b"video")
    target = tmp_path / "clips" / "segment.mp4"

    adapter = ObsWebSocketRecorderAdapter(
        watch_folder=str(tmp_path), host="127.0.0.1", port=4455, password="",
        stable_checks=1, _sleep=lambda _seconds: None,
    )

    assert adapter._wait_for_output_and_move(str(source), str(target)) is True
    assert target.read_bytes() == b"video"
    assert not source.exists()
