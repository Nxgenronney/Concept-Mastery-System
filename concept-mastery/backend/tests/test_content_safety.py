from app.core.content_safety import (
    ContentDecision,
    may_access_restricted_content,
    screen_text,
)


def test_normal_study_content_is_allowed():
    result = screen_text("Introduction to machine learning and neural networks.")
    assert result.decision is ContentDecision.ALLOW


def test_clinical_anatomy_terms_are_not_explicit_by_themselves():
    result = screen_text("Human anatomy: breast, penis, vagina, reproductive system.")
    assert result.decision is ContentDecision.ALLOW


def test_explicit_material_is_restricted_for_non_medical_users():
    result = screen_text("This is hardcore porn and graphic sexual content.")
    assert result.decision is ContentDecision.RESTRICTED
    assert not may_access_restricted_content(medical_verified=False)


def test_medical_context_is_sent_for_review_not_auto_blocked():
    result = screen_text(
        "Medical education lecture on reproductive health and clinical anatomy with explicit sexual content."
    )
    assert result.decision is ContentDecision.REVIEW


def test_verified_medical_user_can_access_restricted_material():
    assert may_access_restricted_content(medical_verified=True)



def test_empty_or_unextractable_content_requires_review():
    result = screen_text("")
    assert result.decision is ContentDecision.REVIEW


def test_verification_is_pending_until_reviewer_approves():
    from app.core import store

    user_id = "content_safety_test_medical_student"
    store.submit_medical_verification_request(
        user_id=user_id,
        institution="Example Medical College",
        program="MBBS",
        educational_email="student@examplemedical.edu",
        id_card_filename="test-id.png",
    )

    assert not store.is_medical_verified(user_id)
    reviewed = store.review_medical_verification_request(
        user_id=user_id,
        status="verified",
        reviewer="test-reviewer",
        notes="Test fixture approval",
    )
    assert reviewed["status"] == "verified"
    assert store.is_medical_verified(user_id)

    store.review_medical_verification_request(
        user_id=user_id,
        status="rejected",
        reviewer="test-reviewer",
        notes="Reset test fixture",
    )
    assert not store.is_medical_verified(user_id)


def test_plain_text_extraction_for_screening():
    from app.core.content_safety import extract_text_for_screening

    extracted = extract_text_for_screening("lecture-notes.txt", b"Gradient descent minimizes a loss function.")
    assert "Gradient descent" in extracted


def test_unsupported_media_is_not_treated_as_safe():
    from app.core.content_safety import extract_text_for_screening

    extracted = extract_text_for_screening("lecture.mp3", b"fake audio")
    assert screen_text(extracted).decision is ContentDecision.REVIEW
