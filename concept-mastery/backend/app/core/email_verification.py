"""Institutional Mailbox Ownership Verification Service.

Provides cryptographically secure email challenge generation, hashing, rate limiting,
and verification. Explicitly treats institutional mailbox control as a separate signal
from medical student program enrollment.
"""
from __future__ import annotations

import hmac
import hashlib
import secrets
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple

from .. import config
from . import store

logger = logging.getLogger("concept_mastery.email_verification")

# Default verification code TTL: 15 minutes
CODE_TTL_MINUTES = 15
MAX_VERIFICATION_ATTEMPTS = 5

# Allowlisted educational TLDs and common academic domains
DISALLOWED_CONSUMER_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "aol.com", "icloud.com", "proton.me", "protonmail.com", "mail.com"
}


def is_valid_institutional_email(email: str) -> Tuple[bool, str]:
    """Validate format and ensure the address is an institutional domain."""
    clean = email.strip().lower()
    if "@" not in clean or "." not in clean.rsplit("@", 1)[-1]:
        return False, "Enter a valid email address with an institutional domain."
    domain = clean.rsplit("@", 1)[-1]
    if domain in DISALLOWED_CONSUMER_DOMAINS:
        return False, "Public consumer email providers (e.g. Gmail, Yahoo) are not permitted. Please use your institution-issued email."
    return True, ""


def hash_token(code_or_token: str) -> str:
    """Hash the verification OTP using SHA-256 with server salt."""
    salt = config.EMAIL_VERIFICATION_SECRET or "default_institution_salt"
    return hmac.new(salt.encode("utf-8"), code_or_token.strip().encode("utf-8"), hashlib.sha256).hexdigest()


def generate_numeric_code(length: int = 6) -> str:
    """Generate a high-entropy cryptographically secure numeric OTP."""
    return "".join(secrets.choice("0123456789") for _ in range(length))


class EmailVerificationService:
    """Service handling institutional email challenges and verification."""

    def __init__(self, secret: str | None = None):
        self.secret = secret or config.EMAIL_VERIFICATION_SECRET

    def send_verification_challenge(
        self,
        user_id: str,
        email: str,
    ) -> dict:
        """Create a challenge OTP, store its hash with TTL, and dispatch via mock/transport."""
        valid, msg = is_valid_institutional_email(email)
        if not valid:
            raise ValueError(msg)

        clean_email = email.strip().lower()
        now = datetime.now(timezone.utc)
        expires_at = (now + timedelta(minutes=CODE_TTL_MINUTES)).isoformat()

        # Generate 6-digit numeric OTP
        raw_code = generate_numeric_code(6)
        code_hash = hash_token(raw_code)

        # Store challenge in DB
        challenge_record = store.save_email_verification_challenge(
            user_id=user_id,
            email=clean_email,
            token_hash=code_hash,
            expires_at=expires_at,
        )

        # In production this sends an actual SMTP/SES email. In dev/test it logs and exposes in test transport.
        logger.info(
            "[EmailVerification] Challenge issued for user %s (%s). Code valid for %d minutes.",
            user_id, clean_email, CODE_TTL_MINUTES
        )

        return {
            "status": "challenge_sent",
            "email": clean_email,
            "expires_in_minutes": CODE_TTL_MINUTES,
            "challenge_id": challenge_record.get("token_id"),
            # Expose debug_code only in development/test environments
            "debug_code": raw_code if config.ENVIRONMENT in ("development", "test") else None,
            "message": f"Verification code sent to {clean_email}. Proves mailbox ownership only, distinct from medical program verification.",
        }

    def verify_challenge(
        self,
        user_id: str,
        email: str,
        submitted_code: str,
    ) -> dict:
        """Verify the user's submitted OTP against stored hash with replay protection."""
        clean_email = email.strip().lower()
        clean_code = submitted_code.strip()
        now_iso = datetime.now(timezone.utc).isoformat()
        candidate_hash = hash_token(clean_code)

        success, reason = store.verify_email_challenge(
            user_id=user_id,
            email=clean_email,
            candidate_hash=candidate_hash,
            now_iso=now_iso,
        )

        if not success:
            return {
                "verified": False,
                "reason": reason,
                "email": clean_email,
            }

        return {
            "verified": True,
            "email": clean_email,
            "verified_at": now_iso,
            "message": "Mailbox ownership verified successfully. Note: This confirms email control, not medical student enrollment.",
        }


DEFAULT_EMAIL_VERIFIER = EmailVerificationService()
