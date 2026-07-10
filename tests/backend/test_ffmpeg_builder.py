"""Focused tests for strict captured-video validation."""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.utils import ffmpeg_builder


def test_validation_rejects_a_clip_when_full_decode_fails(tmp_path, monkeypatch):
    clip = tmp_path / "truncated.mp4"
    clip.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ffmpeg_builder, "get_video_duration", lambda *_: 4.2)
    monkeypatch.setattr(ffmpeg_builder, "_find_ffmpeg_for_validation", lambda _: "ffmpeg")
    monkeypatch.setattr(
        ffmpeg_builder.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="", stderr="partial file"),
    )

    result = ffmpeg_builder.validate_output_file(str(clip), ffprobe_path="ffprobe")

    assert result["valid"] is False
    assert result["decode_checked"] is True
    assert result["errors"] == ["FFmpeg could not decode the clip: partial file"]


def test_validation_accepts_a_clip_only_after_full_decode_succeeds(tmp_path, monkeypatch):
    clip = tmp_path / "playable.mp4"
    clip.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ffmpeg_builder, "get_video_duration", lambda *_: 4.2)
    monkeypatch.setattr(ffmpeg_builder, "_find_ffmpeg_for_validation", lambda _: "ffmpeg")
    calls = []

    def successful_decode(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(ffmpeg_builder.subprocess, "run", successful_decode)

    result = ffmpeg_builder.validate_output_file(str(clip), ffprobe_path="ffprobe")

    assert result["valid"] is True
    assert result["decode_checked"] is True
    assert "-xerror" in calls[0][0][0]
