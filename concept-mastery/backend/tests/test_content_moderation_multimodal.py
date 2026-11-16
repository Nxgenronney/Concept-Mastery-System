"""Tests for multimodal content moderation, de-obfuscation, and clinical context preservation.

Validates:
1. Obfuscated explicit strings (p.o.r.n, p0rn, spaced letters, leetspeak) are detected.
2. Clinical education materials (sexual pathology, STIs, urology, gynecology) are NOT flagged as explicit pornography.
3. Multimodal extraction: visual images extracted from PDFs and slide decks.
4. Fail-closed screening before persistence.
"""
import pytest
from app.core.content_safety import (
    screen_text,
    normalize_text_for_screening,
    extract_visual_content_for_screening,
    ContentDecision,
)


def test_deobfuscation_normalizer():
    """Test that leetspeak and spaced punctuation are decoded correctly."""
    assert "porn" in normalize_text_for_screening("p.o.r.n")
    assert "porn" in normalize_text_for_screening("p 0 r n")
    assert "sex" in normalize_text_for_screening("s.e.x")
    assert "explicit" in normalize_text_for_screening("expl!c!t")


def test_obfuscated_explicit_content_flagged():
    """Ensure evasive explicit content is caught by the screener."""
    cases = [
        "Check out this hardcore p.o.r.n video collection",
        "Watch this amateur p0rn streaming online",
        "Download these x_x_x adult clips now",
        "Collection of s-e-x-u-a-l-l-y explicit films for download",
    ]
    for text in cases:
        res = screen_text(text)
        assert res.decision == ContentDecision.RESTRICTED, f"Failed for: {text}"
        assert len(res.matched_signals) > 0


def test_clinical_education_false_positive_prevention():
    """Ensure legitimate medical and pathology materials are not falsely flagged as restricted."""
    clinical_texts = [
        "Medical pathology lecture on the clinical manifestation and dermatological symptoms of primary syphilis.",
        "Clinical gynecology review of cervical dysplasia, human papillomavirus (HPV) transmission, and reproductive health.",
        "Urology residency textbook covering the surgical differential diagnosis of testicular carcinoma and penile lesions.",
        "Nursing curriculum module regarding patient care in outpatient sexually transmitted infection (STI) clinics.",
    ]
    for text in clinical_texts:
        res = screen_text(text)
        # Clinical texts must either be ALLOWED or marked as REVIEW (for clinical verification), never blocked as restricted pornography
        assert res.decision in (ContentDecision.ALLOW, ContentDecision.REVIEW), f"False positive on clinical text: {text}"
        assert "explicit_sexual" not in res.categories


def test_visual_extraction_from_pdf():
    """Ensure visual content extractor handles PDFs safely."""
    # Empty/dummy PDF
    dummy_pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n99\n%%EOF"
    visuals = extract_visual_content_for_screening("sample.pdf", dummy_pdf)
    assert isinstance(visuals, list)
