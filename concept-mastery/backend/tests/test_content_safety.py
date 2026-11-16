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


def test_verification_is_pending_until_provider_approves():
    """Verification state is authoritative from the vision-OCR provider, not a manual reviewer.

    A pending vision-OCR session must not grant access; only an approved/verified
    provider decision flips ``is_medical_verified``.
    """
    from app.core import store

    user_id = "content_safety_test_medical_student"
    verification_id = "vision-content-safety-test-001"

    # Clean slate for this fixture user.
    existing = store.get_medical_verification_request(user_id)
    if existing:
        with store.get_materials_db() as conn:
            conn.execute("DELETE FROM medical_verification_requests WHERE user_id=?", (user_id,))

    # 1. Pending provider session does NOT grant access.
    store.record_sheerid_verification(
        user_id=user_id,
        verification_id=verification_id,
        program_id="vision_ocr",
        status="pending",
        institution="Example Medical College",
        program="MBBS",
        educational_email="student@examplemedical.edu",
    )
    assert not store.is_medical_verified(user_id)

    # 2. Approved provider decision grants access.
    approved = store.update_sheerid_verification_status(
        verification_id=verification_id,
        status="approved",
        metadata={"provider": "vision_ocr", "decision": "approved"},
    )
    assert approved is not None
    assert approved["status"] == "approved"
    assert store.is_medical_verified(user_id)

    # 3. Rejected provider decision revokes access.
    rejected = store.update_sheerid_verification_status(
        verification_id=verification_id,
        status="rejected",
        metadata={"provider": "vision_ocr", "decision": "rejected"},
    )
    assert rejected is not None
    assert rejected["status"] == "rejected"
    assert not store.is_medical_verified(user_id)

    # 4. Unrecognized provider statuses never grant access.
    store.update_sheerid_verification_status(
        verification_id=verification_id,
        status="bogus_status",
        metadata={"provider": "vision_ocr"},
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
