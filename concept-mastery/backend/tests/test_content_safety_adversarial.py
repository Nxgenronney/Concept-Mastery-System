"""Adversarial regression tests for conservative explicit-content screening."""

import pytest

from app.core.content_safety import ContentDecision, screen_text


@pytest.mark.parametrize(
    "sample",
    [
        "porn",
        "pornography",
        "hardcore porn",
        "p.o.r.n",
        "p o r n",
        "p0rn",
        "sexually explicit content",
        "explicit sexual images",
        "graphic sexual videos",
        "oral sex",
        "anal sex",
        "sexual acts for arousal",
        "XXX",
        "18+ adult",
    ],
)
def test_explicit_signals_are_detected_even_when_obfuscated(sample):
    assert screen_text(sample).decision is ContentDecision.RESTRICTED


@pytest.mark.parametrize(
    "sample",
    [
        "Introduction to machine learning and neural networks.",
        "Human anatomy includes the breast, penis, vagina, and reproductive system.",
        "Breast cancer screening and clinical diagnosis.",
        "Reproductive health and contraception in a nursing lecture.",
        "The physiology of sexual development during adolescence.",
        "An obstetrics textbook explains normal pregnancy and fetal development.",
    ],
)
def test_legitimate_study_material_is_not_flagged_by_anatomy_terms(sample):
    assert screen_text(sample).decision is ContentDecision.ALLOW


def test_explicit_signal_in_clinical_context_is_review_not_auto_allowed():
    sample = (
        "Medical education lecture on reproductive health and clinical anatomy "
        "contains graphic sexual content for clinician training."
    )
    result = screen_text(sample)
    assert result.decision is ContentDecision.REVIEW
    assert result.matched_signals


def test_explicit_signal_without_clinical_context_is_restricted():
    result = screen_text("This page contains graphic sexual content.")
    assert result.decision is ContentDecision.RESTRICTED


def test_empty_content_fails_closed():
    assert screen_text("  \n ").decision is ContentDecision.REVIEW
