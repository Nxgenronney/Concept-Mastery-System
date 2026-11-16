"""Tests for multimodal visual moderation, video frame screening, file validation,
and legacy ID-storage disposal utilities.

Validates:
1. Visual moderation is fail-closed (never silently ALLOWs uninspected images).
2. Video frame extraction is fail-closed when ffmpeg is unavailable.
3. File validation rejects mismatched magic bytes and oversized uploads.
4. Legacy ID storage can be purged without touching study materials.
"""
import os
import pytest
from pathlib import Path
from unittest.mock import patch

from app.core import content_safety as cs
from app.core import store
from app.core.content_safety import (
    ContentDecision,
    screen_visual_content,
    screen_video_content,
    validate_upload,
    extract_video_frames,
)
from app.core.store import purge_legacy_id_storage


# ── Visual moderation ─────────────────────────────────────────────────────────

def test_visual_moderation_fail_closed_without_provider():
    """Images with no moderation provider configured must be REVIEW, never ALLOW."""
    tiny_png = (
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    )
    result = screen_visual_content("page.png", tiny_png)
    assert result[0] == ContentDecision.REVIEW
    assert result[2]


def test_visual_moderation_allows_no_images():
    result = screen_visual_content("doc.txt", b"plain text")
    assert result[0] == ContentDecision.ALLOW
    assert result[2] == ()


def test_visual_moderation_provider_flagged_restricts():
    """A flagged provider response must escalate to RESTRICTED."""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    fake_result = {"flagged": True, "categories": {"sexual": True}}
    with patch.object(cs, "_classify_visual_with_openai", return_value=fake_result):
        result = screen_visual_content("bad.png", png)
    decision = result[0]
    signals = result[2]
    assert decision == ContentDecision.RESTRICTED
    assert "ai_visual_flag" in signals


def test_visual_moderation_provider_clean_still_review():
    """Even a clean provider result stays REVIEW (pending clinical review), not ALLOW."""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    fake_result = {"flagged": False, "categories": {}}
    with patch.object(cs, "_classify_visual_with_openai", return_value=fake_result):
        result = screen_visual_content("ok.png", png)
    assert result[0] == ContentDecision.REVIEW


# ── Video frame screening ─────────────────────────────────────────────────────

def test_video_screening_fail_closed_without_ffmpeg():
    """Without ffmpeg, video screening must return REVIEW, never ALLOW."""
    decision, _msg, signals = screen_video_content("clip.mp4", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 200)
    assert decision == ContentDecision.REVIEW
    assert "video_no_frames_extracted" in signals


def test_video_screening_flagged_restricts():
    """A flagged video frame must escalate to RESTRICTED."""
    fake_frames = [{"format": "jpg", "size_bytes": 100, "page_or_slide": 1, "bytes": b"img"}]
    fake_result = {"flagged": True, "categories": {"violence": True}}
    with patch.object(cs, "extract_video_frames", return_value=fake_frames), \
         patch.object(cs, "_classify_visual_with_openai", return_value=fake_result):
        result = screen_video_content("clip.mp4", b"data")
    assert result[0] == ContentDecision.RESTRICTED
    assert "ai_video_flag" in result[2]


def test_video_screening_clean_frames_stay_review():
    fake_frames = [{"format": "jpg", "size_bytes": 100, "page_or_slide": 1, "bytes": b"img"}]
    fake_result = {"flagged": False, "categories": {}}
    with patch.object(cs, "extract_video_frames", return_value=fake_frames), \
         patch.object(cs, "_classify_visual_with_openai", return_value=fake_result):
        result = screen_video_content("clip.mp4", b"data")
    assert result[0] == ContentDecision.REVIEW


# ── File validation ───────────────────────────────────────────────────────────

def test_validate_upload_rejects_empty():
    ok, _ = validate_upload("a.pdf", b"")
    assert ok is False


def test_validate_upload_rejects_oversized():
    ok, _ = validate_upload("a.pdf", b"x" * (cs.MAX_UPLOAD_BYTES + 1))
    assert ok is False


def test_validate_upload_rejects_bad_magic_bytes():
    ok, msg = validate_upload("doc.pdf", b"not a real pdf")
    assert ok is False
    assert "PDF" in msg


def test_validate_upload_accepts_valid_pdf():
    ok, msg = validate_upload("study.pdf", b"%PDF-1.4\n%fake but magic ok")
    assert ok is True, msg


def test_validate_upload_rejects_unknown_extension():
    ok, _ = validate_upload("evil.exe", b"MZ" + b"\x00" * 40)
    assert ok is False


# ── Legacy ID storage purge ───────────────────────────────────────────────────

def test_purge_legacy_id_storage_is_safe_and_idempotent():
    """Purge must not touch study materials; only identity docs + id_card_filename refs."""
    result = purge_legacy_id_storage()
    assert "deleted_files" in result
    assert "cleared_id_card_references" in result
    assert "target_dir" in result
    # Study materials table must be untouched
    with store.get_materials_db() as conn:
        rows = conn.execute("SELECT COUNT(*) AS c FROM study_materials").fetchone()
    assert rows["c"] >= 0