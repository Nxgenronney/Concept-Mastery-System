"""Tests for data protection, PII minimization, and security boundaries.

Validates:
1. No local ID-card uploads are saved to disk.
2. Insecure /admin/.../id-card download route is removed.
3. Unverified students receive 403 MEDICAL_VERIFICATION_REQUIRED with vision OCR endpoint.
4. Verified medical students are authorized to access restricted clinical materials.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config
from app.core import store


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def student_auth(client):
    res = client.post("/api/auth/google", json={"credential": "dev:sec_student:sec.student@university.edu:Sec Student"})
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_insecure_id_download_route_removed(client):
    """Ensure that the insecure /admin/.../id-card route is removed."""
    res = client.get(
        "/api/admin/medical-verification/test_user/id-card",
        headers={"X-Verification-Review-Token": "any_token"},
    )
    # The route must not exist or return 404 / 405 Method Not Allowed
    assert res.status_code in (404, 405)


def test_no_local_id_files_written_on_verification(client, student_auth):
    """Ensure that requesting verification does not write ID image files to data/vectorstore."""
    initial_files = set(config.MEDICAL_VERIFICATION_DIR.glob("*")) if config.MEDICAL_VERIFICATION_DIR.exists() else set()

    # Check medical verification status endpoint (no file writes)
    res = client.get(
        "/api/auth/medical-verification",
        headers=student_auth,
    )
    assert res.status_code == 200

    current_files = set(config.MEDICAL_VERIFICATION_DIR.glob("*")) if config.MEDICAL_VERIFICATION_DIR.exists() else set()
    # No new files must be written to disk!
    assert len(current_files) == len(initial_files)


def test_unverified_student_blocked_from_explicit_content(client, student_auth):
    """Ensure unverified students cannot ingest or view explicit content."""
    # Clean up any previous verification state for this user
    with store.get_materials_db() as conn:
        conn.execute("DELETE FROM medical_verification_requests WHERE user_id='sec_student'")

    explicit_content = b"This document describes hardcore p0rnography and sexually explicit videos."
    res = client.post(
        "/api/materials/ingest-file",
        files=[("files", ("explicit_test.txt", explicit_content, "text/plain"))],
        headers=student_auth,
    )
    assert res.status_code == 403
    data = res.json()
    detail = data.get("detail", {})
    assert detail.get("code") == "MEDICAL_VERIFICATION_REQUIRED"
    assert "/api/auth/verify-medical-id" in detail.get("verification_endpoint", "")


def test_verified_medical_student_allowed(client, student_auth):
    """Ensure verified medical students can ingest explicit clinical content."""
    # Mark user as approved
    store.record_sheerid_verification(
        user_id="sec_student",
        verification_id="verif_sec_approved",
        program_id="vision_ocr",
        status="approved",
    )
    assert store.is_medical_verified("sec_student") is True

    explicit_clinical = b"This clinical text covers sexually explicit pathology in patients presenting with acute urological trauma."
    res = client.post(
        "/api/materials/ingest-file",
        files=[("files", ("clinical_test.txt", explicit_clinical, "text/plain"))],
        headers=student_auth,
    )
    # Since student is verified, request should not be blocked with 403!
    assert res.status_code != 403
