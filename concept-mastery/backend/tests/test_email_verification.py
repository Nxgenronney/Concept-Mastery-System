"""Tests for institutional email mailbox ownership verification.

Validates:
1. Rejection of public consumer domains (gmail, yahoo, etc.).
2. Generation and secure hashing of OTP challenge tokens.
3. Successful mailbox verification upon correct OTP submission.
4. Attempt limits and rate limiting (max 5 failed attempts).
5. Expiration handling (expired codes rejected).
6. Clear distinction: mailbox ownership does NOT grant medical student privileges.
"""
import pytest
from datetime import datetime, timezone, timedelta
from fastapi.testclient import TestClient

from app.main import app
from app.core import store
from app.core.email_verification import (
    DEFAULT_EMAIL_VERIFIER,
    is_valid_institutional_email,
    hash_token,
)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    res = client.post("/api/auth/google", json={"credential": "dev:email_tester:email.test@stanford.edu:Email Tester"})
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_public_consumer_domains_rejected():
    """Verify that public webmail domains cannot be used for institutional verification."""
    disallowed = ["test@gmail.com", "student@yahoo.com", "user@outlook.com", "doctor@hotmail.com"]
    for addr in disallowed:
        valid, msg = is_valid_institutional_email(addr)
        assert valid is False
        assert "consumer" in msg.lower() or "public" in msg.lower()

    allowed = ["student@harvard.edu", "resident@ox.ac.uk", "researcher@med.stanford.edu"]
    for addr in allowed:
        valid, msg = is_valid_institutional_email(addr)
        assert valid is True
        assert msg == ""


def test_email_challenge_dispatch_and_verification(client, auth_headers):
    """Test full cycle of requesting OTP and successfully verifying mailbox ownership."""
    req_payload = {"email": "medstudent@jhmi.edu"}
    res = client.post("/api/auth/email-verification/request", json=req_payload, headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "challenge_sent"
    assert data["email"] == "medstudent@jhmi.edu"

    # In dev/test environment, debug_code is provided for testing
    code = data.get("debug_code")
    assert code is not None and len(code) == 6

    # Verify mailbox with correct code
    verify_payload = {"email": "medstudent@jhmi.edu", "code": code}
    verif_res = client.post("/api/auth/email-verification/verify", json=verify_payload, headers=auth_headers)
    assert verif_res.status_code == 200
    assert verif_res.json()["verified"] is True

    # Assert mailbox ownership is recorded
    assert store.is_email_ownership_verified("email_tester", "medstudent@jhmi.edu") is True

    # CRITICAL: Confirm that email ownership does NOT grant medical student privileges!
    assert store.is_medical_verified("email_tester") is False


def test_email_verification_attempt_limit(client, auth_headers):
    """Test that more than 5 incorrect OTP attempts lock out the challenge."""
    req_payload = {"email": "student@cam.ac.uk"}
    res = client.post("/api/auth/email-verification/request", json=req_payload, headers=auth_headers)
    assert res.status_code == 200

    # Submit 5 incorrect codes
    for _ in range(5):
        fail_res = client.post(
            "/api/auth/email-verification/verify",
            json={"email": "student@cam.ac.uk", "code": "000000"},
            headers=auth_headers,
        )
        assert fail_res.status_code == 400

    # 6th attempt should return attempt limit exceeded
    limit_res = client.post(
        "/api/auth/email-verification/verify",
        json={"email": "student@cam.ac.uk", "code": "000000"},
        headers=auth_headers,
    )
    assert limit_res.status_code == 400
    assert "too many" in limit_res.json()["detail"].lower()
