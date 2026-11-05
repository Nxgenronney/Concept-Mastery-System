"""FastAPI Routes for the Closed-Loop Concept Mastery Platform.

Endpoints:
  - POST /api/upload: Upload PDF, run vectorless indexing, construct prerequisite DAG.
  - GET  /api/concepts/graph: Return full DAG nodes, edges, and user mastery states.
  - POST /api/loop/start: Initialize or resume the closed-loop learning session.
  - POST /api/quiz/submit: Submit answers, trigger LangGraph evaluation, and return next adaptive action.
  - POST /api/tutor/chat: Grounded Socratic conversational endpoint.
  - GET  /api/dashboard/{user_id}: Return explainable learner dashboard.
  - All existing routes preserved for seamless SPA frontend compatibility.
"""

import logging
import time
import hmac
import uuid
from pathlib import Path
from typing import Optional, Literal
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request, Depends, Query, Body, Header
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config
from .core import store, tts
from .core.content_safety import ContentDecision, extract_text_for_screening, screen_text
from .core.auth import get_current_user, create_access_token, verify_google_credential
from .pipelines import ingest, tutor, quiz, mastery, recommend, loop, concepts, active_recall, notes, tools, mastery_orchestrator
from .pipelines.concepts import export_graph
from .models.schemas import (
    UploadResponse,
    GraphExport,
    QuizSubmission,
    BaselineSubmissionRequest,
    TutorChatRequest,
    TutorChatResponse,
    LearnerDashboard,
    LoopActionResponse,
    IngestStatusResponse,
    IngestUrlRequest,
    StudyMaterialMetadata,
    StudyMaterialPreview,
    MaterialsListResponse,
    User,
    UserLoginLog,
    GoogleAuthRequest,
    AuthTokenResponse,
    ActiveRecallStartRequest,
    ActiveRecallStudyCard,
    ActiveRecallEvaluateRequest,
    ActiveRecallResult,
    ActiveRecallHistoryItem,
    SmartNoteRequest,
    SmartNoteResponse,
    ToolGenerateRequest,
    DeepAudioRequest,
    EvaluateEvidenceRequest,
    EvaluateEvidenceResponse,
    ConceptDeliberationResponse,
    HeadTeacherDecision,
    SpecialistAgentAssessment,
    LearningEvidenceRecord,
)
from .pipelines.ingest import UniversalMaterialIngestor

# Ensure store.get_material alias exists for study materials
if not hasattr(store, "get_material"):
    store.get_material = store.get_study_material

logger = logging.getLogger("concept_mastery.routes")

router = APIRouter(prefix="/api")


# ── Health ─────────────────────────────────────────────────────────────────

@router.get("/health")
def health():
    return {
        "ok": True,
        "service": "concept-mastery-platform",
        "version": "2.0.0",
        "google_client_id": config.GOOGLE_CLIENT_ID,
        "google_auth_configured": bool(config.GOOGLE_CLIENT_ID)
    }


# ── Authentication & Student Profiles ─────────────────────────────────────

@router.get("/auth/config")
def get_auth_config():
    """Return public OAuth configuration for frontend initialization."""
    return {
        "google_client_id": config.GOOGLE_CLIENT_ID,
        "google_auth_configured": bool(config.GOOGLE_CLIENT_ID)
    }

@router.post("/auth/google", response_model=AuthTokenResponse)
@router.post("/auth/google/", response_model=AuthTokenResponse)
def post_auth_google(req: GoogleAuthRequest, request: Request):
    """Verify Google ID Token credential, upsert student account, log session, and issue session JWT."""
    idinfo = verify_google_credential(req.credential)
    user_id = idinfo["sub"]
    email = idinfo["email"]
    full_name = idinfo.get("name", "")
    picture_url = idinfo.get("picture", "")

    user_dict = store.upsert_user(
        user_id=user_id,
        email=email,
        full_name=full_name,
        picture_url=picture_url
    )

    client_ip = request.client.host if request.client else None
    user_agent = request.headers.get("User-Agent")
    store.record_login_log(user_id=user_id, ip_address=client_ip, user_agent=user_agent)

    token = create_access_token({"sub": user_id, "email": email, "name": full_name, "picture": picture_url})
    return AuthTokenResponse(
        access_token=token,
        token_type="bearer",
        user=User(**user_dict)
    )


@router.get("/auth/me")
@router.get("/auth/me/")
def get_auth_me(current_user: User = Depends(get_current_user)):
    """Return profile and active session for the authenticated student."""
    logs = store.get_user_login_logs(current_user.user_id, limit=5)
    return {
        "authenticated": True,
        "user": current_user,
        "recent_logins": logs
    }


@router.get("/auth/logs")
@router.get("/auth/logs/")
def get_auth_logs(current_user: User = Depends(get_current_user)):
    """Return full login activity trail for the active student."""
    return {
        "user_id": current_user.user_id,
        "logs": store.get_user_login_logs(current_user.user_id)
    }


# ── Medical-content access control ─────────────────────────────────────────

async def _enforce_content_policy(upload: UploadFile, user_id: str) -> None:
    """Screen extracted document text before any content is persisted or indexed."""
    if not upload.filename:
        raise HTTPException(status_code=400, detail="Uploaded file must have a filename.")
    raw = await upload.read()
    await upload.seek(0)
    try:
        extracted = extract_text_for_screening(upload.filename, raw)
    except Exception as exc:
        logger.warning("Could not screen uploaded file %s: %s", upload.filename, exc)
        raise HTTPException(
            status_code=422,
            detail="This file could not be screened automatically. Upload a text-readable PDF/DOCX/PPTX/TXT/MD file or request manual review."
        )
    result = screen_text(extracted)
    if result.decision == ContentDecision.REVIEW and not result.matched_signals:
        raise HTTPException(
            status_code=422,
            detail="This file has no supported extractable text (for example, scanned PDFs or audio/video). It was not uploaded; manual moderation or OCR is required."
        )
    if result.matched_signals and not store.is_medical_verified(user_id):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "MEDICAL_VERIFICATION_REQUIRED",
                "message": "This material contains explicit-content signals. Only verified medical students can access it. Submit your medical student ID and institution-issued email for review.",
                "verification_endpoint": "/api/auth/medical-verification",
                "signals": list(result.matched_signals),
            },
        )


def _require_verification_reviewer(token: str | None) -> None:
    expected = config.MEDICAL_VERIFICATION_REVIEW_TOKEN
    if not expected or not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=403, detail="Authorized verification reviewer access is required.")


class MedicalVerificationReview(BaseModel):
    status: Literal["verified", "rejected"]
    notes: str = ""


@router.get("/auth/medical-verification")
def get_medical_verification_status(current_user: User = Depends(get_current_user)):
    request_record = store.get_medical_verification_request(current_user.user_id)
    return {
        "status": request_record.get("status", "not_submitted") if request_record else "not_submitted",
        "request": request_record,
    }


@router.post("/auth/medical-verification")
async def submit_medical_verification(
    institution: str = Form(...),
    program: str = Form(...),
    educational_email: str = Form(...),
    id_card: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Submit a medical ID card and institution email for manual verification."""
    if not institution.strip() or not program.strip():
        raise HTTPException(status_code=400, detail="Institution and medical program are required.")
    email = educational_email.strip().lower()
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(status_code=400, detail="Enter a valid institution-issued email address.")
    if email.endswith(("@gmail.com", "@yahoo.com", "@outlook.com", "@hotmail.com")):
        raise HTTPException(status_code=400, detail="Use an institution-issued educational email, not a public email provider.")
    suffix = Path(id_card.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".pdf"}:
        raise HTTPException(status_code=400, detail="Student ID must be a PNG, JPG, or PDF file.")
    evidence = await id_card.read()
    if not evidence or len(evidence) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Student ID file must be between 1 byte and 5 MB.")
    if suffix == ".pdf" and not evidence.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="The uploaded ID does not appear to be a valid PDF.")
    if suffix == ".png" and not evidence.startswith(bytes([137, 80, 78, 71])):
        raise HTTPException(status_code=400, detail="The uploaded ID does not appear to be a valid PNG image.")
    if suffix in {".jpg", ".jpeg"} and not evidence.startswith(bytes([255, 216, 255])):
        raise HTTPException(status_code=400, detail="The uploaded ID does not appear to be a valid JPEG image.")
    previous = next((r for r in store.list_medical_verification_requests() if r["user_id"] == current_user.user_id), None)
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    evidence_path = config.MEDICAL_VERIFICATION_DIR / stored_name
    evidence_path.write_bytes(evidence)
    try:
        evidence_path.chmod(0o600)
    except OSError:
        pass
    store.submit_medical_verification_request(
        user_id=current_user.user_id,
        institution=institution.strip()[:200],
        program=program.strip()[:160],
        educational_email=email,
        id_card_filename=stored_name,
    )
    if previous:
        old_path = config.MEDICAL_VERIFICATION_DIR / Path(previous["id_card_filename"]).name
        if old_path != evidence_path:
            old_path.unlink(missing_ok=True)
    return {
        "ok": True,
        "status": "pending",
        "message": "Your request is pending manual review. Access remains restricted until the ID card and institution email are checked.",
    }


@router.get("/admin/medical-verification")
def list_medical_verification_requests(
    x_verification_review_token: str | None = Header(None),
):
    _require_verification_reviewer(x_verification_review_token)
    return {"requests": store.list_medical_verification_requests()}


@router.get("/admin/medical-verification/{user_id}/id-card")
def get_medical_verification_id_card(
    user_id: str,
    x_verification_review_token: str | None = Header(None),
):
    _require_verification_reviewer(x_verification_review_token)
    record = next((r for r in store.list_medical_verification_requests() if r["user_id"] == user_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="Verification request not found.")
    safe_name = Path(record["id_card_filename"]).name
    path = (config.MEDICAL_VERIFICATION_DIR / safe_name).resolve()
    if path.parent != config.MEDICAL_VERIFICATION_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="ID evidence not found.")
    media_type = "application/pdf" if path.suffix.lower() == ".pdf" else "image/jpeg"
    if path.suffix.lower() == ".png":
        media_type = "image/png"
    return FileResponse(str(path), media_type=media_type, filename="medical-student-id" + path.suffix)


@router.post("/admin/medical-verification/{user_id}/review")
def review_medical_verification(
    user_id: str,
    body: MedicalVerificationReview,
    x_verification_review_token: str | None = Header(None),
):
    _require_verification_reviewer(x_verification_review_token)
    record = next((r for r in store.list_medical_verification_requests() if r["user_id"] == user_id), None)
    reviewed = store.review_medical_verification_request(
        user_id=user_id,
        status=body.status,
        reviewer="configured-verification-reviewer",
        notes=body.notes,
    )
    if record:
        evidence_path = (config.MEDICAL_VERIFICATION_DIR / Path(record["id_card_filename"]).name).resolve()
        if evidence_path.parent == config.MEDICAL_VERIFICATION_DIR.resolve():
            evidence_path.unlink(missing_ok=True)
    if not reviewed:
        raise HTTPException(status_code=404, detail="Verification request not found.")
    return {"ok": True, "request": reviewed}


# ── 1. Document Ingestion & Vectorless Index ───────────────────────────────

async def _save_uploaded_pdfs(files: list[UploadFile], file: UploadFile | None, user_id: str) -> list[Path]:
    all_uploads: list[UploadFile] = list(files or [])
    if file:
        all_uploads.append(file)

    valid_pdfs = [f for f in all_uploads if f.filename and f.filename.lower().endswith(".pdf")]
    if not valid_pdfs:
        raise HTTPException(status_code=400, detail="Please upload at least one valid PDF file.")

    for upload in valid_pdfs:
        await _enforce_content_policy(upload, user_id)

    saved_paths: list[Path] = []
    for f in valid_pdfs:
        fname = Path(f.filename).name
        dest = config.UPLOAD_DIR / fname
        content = await f.read()
        dest.write_bytes(content)
        saved_paths.append(dest)
    return saved_paths


@router.post("/upload", response_model=UploadResponse)
@router.post("/upload/", response_model=UploadResponse)
async def post_upload(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
):
    """Upload one or multiple screened PDFs and build the prerequisite DAG."""
    saved_paths = await _save_uploaded_pdfs(files, file, current_user.user_id)
    try:
        res = await ingest.run_ingest_async(saved_paths)
        return UploadResponse(**res)
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {e}")


@router.post("/ingest")
@router.post("/ingest/")
async def post_ingest(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
):
    """Ingest screened PDFs while maintaining existing SPA compatibility."""
    saved_paths = await _save_uploaded_pdfs(files, file, current_user.user_id)
    try:
        res = await ingest.run_ingest_async(saved_paths)
        return {"jobId": res["job_id"], **res}
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Couldn't read PDF(s): {e}")


@router.post("/ingest/upload")
@router.post("/ingest/upload/")
async def post_ingest_upload(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
):
    return await post_upload(files=files, file=file, current_user=current_user)


@router.get("/ingest/status", response_model=IngestStatusResponse)
@router.get("/ingest/status/", response_model=IngestStatusResponse)
@router.post("/ingest/status", response_model=IngestStatusResponse)
@router.post("/ingest/status/", response_model=IngestStatusResponse)
def ingest_status():
    kb = store.KB
    return IngestStatusResponse(
        ready=kb.get("ready", False),
        file=kb.get("file"),
        pages=kb.get("pages"),
        concepts=len(kb.get("concepts", []))
    )


@router.post("/ingest/sample")
@router.post("/ingest/sample/")
@router.get("/ingest/sample")
@router.get("/ingest/sample/")
def post_ingest_sample():
    candidates = [
        config.UPLOAD_DIR / "ml-basics.pdf",
        config.BASE.parent / "sample" / "ml-basics.pdf",
        config.BASE / "sample" / "ml-basics.pdf",
        Path.cwd() / "sample" / "ml-basics.pdf",
        Path.cwd() / "concept-mastery" / "sample" / "ml-basics.pdf"
    ]
    sample_path = next((p for p in candidates if p.exists()), None)
    if not sample_path:
        raise HTTPException(
            status_code=404,
            detail="Sample PDF not found. The sample directory was removed. Please upload your course or study PDF using the file uploader above."
        )
    dest = config.UPLOAD_DIR / sample_path.name
    if sample_path != dest:
        dest.write_bytes(sample_path.read_bytes())
    res = ingest.run_ingest(dest)
    return {"jobId": sample_path.name, **res}


# ── 2. Prerequisite Concept Graph ──────────────────────────────────────────

@router.get("/concepts/graph")
@router.get("/concepts/graph/")
def get_concepts_graph(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Return full DAG nodes, directed edges, and user mastery states."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else user_id
    kb = store.get_kb(uid)
    mats = store.list_study_materials(uid)
    if not mats and not kb.get("ready"):
        return {"nodes": [], "edges": [], "learning_path": []}
    if not kb.get("ready") or not kb.get("concepts"):
        return {"nodes": [], "edges": [], "learning_path": []}
    snap = mastery.snapshot(uid)
    mastery_map = {s["id"]: s["state"] for s in snap}
    return export_graph(mastery_map, user_id=uid)


@router.get("/graph")
def get_graph(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Legacy graph endpoint for existing frontend view."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else user_id
    mats = store.list_study_materials(uid)
    if not mats:
        return {"nodes": [], "edges": []}
    kb = store.get_kb(uid)
    if not kb.get("ready"):
        return {"nodes": [], "edges": []}
    return {
        "nodes": [{k: c[k] for k in ("id", "name", "x", "y")} for c in kb.get("concepts", [])],
        "edges": kb.get("edges", [])
    }


# ── 3. Grounded Socratic Tutor ─────────────────────────────────────────────

@router.post("/tutor/chat", response_model=TutorChatResponse)
@router.post("/tutor/chat/", response_model=TutorChatResponse)
def post_tutor_chat(req: TutorChatRequest, current_user: User = Depends(get_current_user)):
    """Grounded Socratic conversational endpoint with two-layer anti-hallucination guardrails."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and req.user_id == "default" else req.user_id
    return tutor.chat(
        message=req.message,
        concept_id=req.concept_id,
        user_id=uid,
    )


class LegacyAsk(BaseModel):
    question: str
    docId: str | None = None
    conceptId: str | None = None

@router.post("/tutor/ask")
def legacy_ask(body: LegacyAsk):
    return tutor.chat(message=body.question, concept_id=body.conceptId).model_dump()


class WebSearchRequest(BaseModel):
    query: str
    max_results: int = 5


@router.post("/tutor/search")
@router.post("/web/search")
def post_web_search(req: WebSearchRequest):
    """Execute live web search via TinyFish Search API."""
    from .core import web_search
    results = web_search.search(req.query, max_results=req.max_results)
    return {"query": req.query, "results": results, "count": len(results)}


# ── 4. Assessment & Quiz Engine ────────────────────────────────────────────

@router.post("/quiz/submit")
@router.post("/quiz/submit/")
def post_quiz_submit(sub: QuizSubmission, current_user: User = Depends(get_current_user)):
    """Submit quiz option + reasoning, trigger LangGraph evaluation, return next adaptive action."""
    if sub.user_id == "default" and current_user and current_user.user_id != "default":
        sub.user_id = current_user.user_id
    return loop.submit_quiz_answer(sub)


class LegacyQuizReq(BaseModel):
    conceptId: str | None = None
    concept_id: str | None = None
    user_id: str | None = None

@router.post("/quiz/next")
@router.post("/quiz/next/")
def legacy_quiz_next(body: LegacyQuizReq = LegacyQuizReq(), current_user: User = Depends(get_current_user)):
    """Generate fresh non-duplicate question variants for Concept Check."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" else (body.user_id if body and body.user_id else "default")
    cid = body.conceptId or body.concept_id
    try:
        return quiz.next_question(cid, user_id=uid)
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))


class RemedialQuizReq(BaseModel):
    conceptId: str | None = None
    concept_id: str | None = None
    user_id: str | None = "default"

@router.post("/quiz/remedial")
@router.post("/quiz/remedial/", include_in_schema=False)
def post_quiz_remedial(body: RemedialQuizReq = RemedialQuizReq(), current_user: User = Depends(get_current_user)):
    """Generate a targeted remedial quiz for the student's top WEAK prerequisite root cause."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" else (body.user_id if body and body.user_id else "default")
    cid = body.conceptId or body.concept_id
    try:
        res = loop.generate_remedial_quiz(user_id=uid, target_concept_id=cid)
        if "question" not in res or not isinstance(res["question"], dict):
            res["question"] = dict(res)
        res["ok"] = True
        return res
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))


class LegacyAnswer(BaseModel):
    questionId: str | None = None
    conceptId: str
    correct: bool | None = None
    selectedIndex: int | None = None
    studentReasoning: str | None = None
    typedAnswer: str | None = None
    numericAnswer: float | None = None
    numeric_answer: float | None = None

@router.post("/quiz/answer")
def legacy_quiz_answer(body: LegacyAnswer):
    num_val = body.numericAnswer if body.numericAnswer is not None else body.numeric_answer
    sub = QuizSubmission(
        user_id="default",
        question_id=body.questionId or "legacy_q",
        concept_id=body.conceptId,
        selected_option_idx=body.selectedIndex,
        typed_answer=body.typedAnswer or "",
        student_reasoning=body.studentReasoning or (body.typedAnswer or ""),
        numeric_answer=num_val,
    )
    res = loop.submit_quiz_answer(sub)
    q_data = quiz.REGISTRY.get(sub.question_id, quiz.RECENT_QUESTIONS.get(sub.question_id, {}))
    return {
        "mastery": mastery.snapshot(),
        "next": res.get("next_concept_id", body.conceptId),
        "correct": res["is_correct"],
        "correctIndex": res["correct_option_idx"],
        "explanation": res["explanation"],
        "next_action": res["next_action"],
        "remedial_lesson": res.get("remedial_lesson"),
        "question_type": res.get("question_type", "mcq"),
        "correct_answer_display": res.get("correct_answer_display", ""),
        "user_answer": res.get("user_answer", ""),
        "reasoning_depth_level": res.get("reasoning_depth_level", "DEVELOPING"),
        "step_by_step_solution": res.get("step_by_step_solution") or q_data.get("step_by_step_solution"),
    }


class LegacyEvaluateReq(BaseModel):
    conceptId: str
    questionText: str = ""
    studentAnswer: str
    groundTruth: str = ""

@router.post("/quiz/evaluate")
def legacy_quiz_evaluate(body: LegacyEvaluateReq):
    return quiz.evaluate_answer(
        student_answer=body.studentAnswer,
        concept_id=body.conceptId,
        question_text=body.questionText,
        ground_truth=body.groundTruth
    )


# ── 4.5 Active Recall Pipeline ─────────────────────────────────────────────

@router.post("/active-recall/start", response_model=ActiveRecallStudyCard)
@router.post("/active-recall/start/", response_model=ActiveRecallStudyCard)
def post_active_recall_start(req: ActiveRecallStartRequest, current_user: User = Depends(get_current_user)):
    """Initialize an Active Recall study session with grounded Study Card & verification question."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and req.user_id == "default" else req.user_id
    try:
        return active_recall.start_session(
            user_id=uid,
            concept_id=req.concept_id,
            timer_seconds=req.timer_seconds,
        )
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        logger.error(f"Failed to start active recall session: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start active recall session: {e}")


@router.post("/active-recall/evaluate", response_model=ActiveRecallResult)
@router.post("/active-recall/evaluate/", response_model=ActiveRecallResult)
def post_active_recall_evaluate(req: ActiveRecallEvaluateRequest, current_user: User = Depends(get_current_user)):
    """Evaluate student active recall retrieval text & verification answer using AI Mastery Judge."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and req.user_id == "default" else req.user_id
    try:
        return active_recall.evaluate_session(
            user_id=uid,
            session_id=req.session_id,
            concept_id=req.concept_id,
            recall_text=req.recall_text,
            verification_answer=req.verification_answer,
        )
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        logger.error(f"Failed to evaluate active recall session: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to evaluate active recall session: {e}")


@router.get("/active-recall/history", response_model=list[ActiveRecallHistoryItem])
@router.get("/active-recall/history/", response_model=list[ActiveRecallHistoryItem])
def get_active_recall_history(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Retrieve active recall session history for active learner."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else user_id
    return active_recall.get_history(user_id=uid)


# ── 5. Epistemic Mastery Engine & Learner Dashboard ────────────────────────

@router.get("/dashboard/{user_id}", response_model=LearnerDashboard)
@router.get("/dashboard/{user_id}/", response_model=LearnerDashboard)
def get_user_dashboard(user_id: str, current_user: User = Depends(get_current_user)):
    """Return explainable learner dashboard with UNKNOWN, WEAK, and STRONG concept buckets."""
    uid = user_id if user_id != "default" else (current_user.user_id if current_user else "default")
    kb = store.get_kb(uid)
    if not kb.get("ready") or not kb.get("concepts"):
        return LearnerDashboard(
            user_id=uid,
            strong=[],
            weak=[],
            unknown=[],
            overall_score=0.0,
            total_concepts=0,
            summary="No study materials uploaded yet. Upload a document or URL to begin."
        )
    return mastery.get_dashboard(uid)


@router.get("/mastery")
@router.get("/mastery/")
def get_mastery(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Return concepts mastery snapshot scoped to the authenticated student."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else (current_user.user_id if current_user else user_id)
    mats = store.list_study_materials(uid)
    kb = store.get_kb(uid)
    if not mats and not (kb and kb.get("concepts")):
        return {"concepts": []}
    return {"concepts": mastery.snapshot(uid)}


@router.get("/mastery/dashboard")
@router.get("/mastery/dashboard/")
def get_mastery_dashboard(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Return dashboard scoped to authenticated student with status_counts and overall_mastery."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else (current_user.user_id if current_user else user_id)
    mats = store.list_study_materials(uid)
    kb = store.get_kb(uid)
    if not mats and not (kb and kb.get("concepts")):
        return {
            "overall_mastery": 0,
            "concepts": [],
            "status_counts": {"strong": 0, "weak": 0, "unknown": 0},
            "overall_score": 0.0,
            "total_concepts": 0,
            "strong": [],
            "weak": [],
            "unknown": [],
            "summary": "No study materials uploaded yet. Upload a document or URL to begin."
        }
    dash = mastery.get_dashboard(uid)
    snap = mastery.snapshot(uid)
    res = dash.model_dump()
    res["overall_mastery"] = dash.overall_score
    res["concepts"] = snap
    res["status_counts"] = {
        "strong": len(dash.strong),
        "weak": len(dash.weak),
        "unknown": len(dash.unknown)
    }
    return res


@router.post("/mastery/evaluate-evidence", response_model=EvaluateEvidenceResponse)
@router.post("/mastery/evaluate-evidence/", response_model=EvaluateEvidenceResponse)
def post_mastery_evaluate_evidence(
    req: EvaluateEvidenceRequest,
    current_user: User = Depends(get_current_user),
):
    """Evaluate student learning evidence via 4 specialist agents & Head Teacher Arbiter."""
    uid = (
        current_user.user_id
        if current_user and current_user.user_id != "default" and req.user_id == "default"
        else (req.user_id if req.user_id and req.user_id != "default" else (current_user.user_id if current_user else "default"))
    )
    req.user_id = uid
    if req.student_explanation and len(req.student_explanation) > 4000:
        req.student_explanation = req.student_explanation[:4000]
    if req.student_answer and len(req.student_answer) > 4000:
        req.student_answer = req.student_answer[:4000]
    decision, findings = mastery_orchestrator.evaluate_concept_learning_evidence(req, user_id=uid)
    return EvaluateEvidenceResponse(decision=decision, specialist_findings=findings)


@router.get("/mastery/{concept_id}/deliberation", response_model=ConceptDeliberationResponse)
@router.get("/mastery/{concept_id}/deliberation/", response_model=ConceptDeliberationResponse)
def get_concept_deliberation(
    concept_id: str,
    user_id: str = "default",
    current_user: User = Depends(get_current_user),
):
    """Return full explainable deliberation, 4 specialist findings, and evidence items for a concept."""
    uid = (
        current_user.user_id
        if current_user and current_user.user_id != "default" and user_id == "default"
        else (current_user.user_id if current_user else user_id)
    )
    decision = store.get_latest_mastery_decision(uid, concept_id)
    if not decision:
        return ConceptDeliberationResponse(
            concept_id=concept_id,
            user_id=uid,
            decision=None,
            specialist_findings=[],
            evidence_records=[],
        )

    findings_dicts = store.list_specialist_findings(decision["decision_id"], user_id=uid)
    evidence_dicts = store.list_learning_evidence(uid, concept_id)

    dec_obj = HeadTeacherDecision(**decision)
    findings_objs = [SpecialistAgentAssessment(**f) for f in findings_dicts]
    evidence_objs = [LearningEvidenceRecord(**e) for e in evidence_dicts]

    return ConceptDeliberationResponse(
        concept_id=concept_id,
        user_id=uid,
        decision=dec_obj,
        specialist_findings=findings_objs,
        evidence_records=evidence_objs,
    )





@router.get("/diagnostic/baseline")
@router.get("/diagnostic/baseline/")
@router.post("/diagnostic/baseline")
@router.post("/diagnostic/baseline/")
def get_or_post_diagnostic_baseline(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Generate calibrated 6-question baseline test sampling root and foundational nodes from DAG."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and user_id == "default" else (current_user.user_id if current_user else user_id)
    try:
        return loop.generate_baseline_diagnostic(user_id=uid)
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate baseline diagnostic: {e}")


@router.post("/diagnostic/baseline/evaluate")
@router.post("/diagnostic/baseline/evaluate/")
@router.post("/diagnostic/baseline/submit")
@router.post("/diagnostic/baseline/submit/")
def post_diagnostic_baseline_evaluate(body: BaselineSubmissionRequest, current_user: User = Depends(get_current_user)):
    """Evaluate baseline diagnostic answers and transition learner lifecycle to ACTIVE_LEARNING."""
    uid = current_user.user_id if current_user and current_user.user_id != "default" and body.user_id == "default" else (current_user.user_id if current_user else body.user_id)
    try:
        return loop.evaluate_baseline_diagnostic(user_id=uid, submissions=body.submissions)
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to evaluate baseline diagnostic: {e}")


@router.post("/mastery/reset")
def post_mastery_reset():
    kb = store.KB
    if not kb.get("ready"):
        raise HTTPException(status_code=400, detail="No active study material loaded.")
    mastery.reset(kb["concepts"])
    return {"ok": True, "concepts": mastery.snapshot()}


# ── 6. Closed-Loop LangGraph Orchestrator ──────────────────────────────────

class StartSessionReq(BaseModel):
    user_id: str = "default"

@router.post("/loop/start")
@router.post("/loop/start/")
def post_loop_start(body: StartSessionReq | None = None, current_user: User = Depends(get_current_user)):
    """Initialize or advance the closed-loop learning session for a student."""
    uid = "default"
    if body and body.user_id != "default":
        uid = body.user_id
    elif current_user and current_user.user_id != "default":
        uid = current_user.user_id
    return loop.start_session(uid)


@router.post("/loop/next-action")
def post_loop_next_action():
    return loop.start_session("default")


@router.post("/recommend")
def post_recommend():
    return recommend.recommend()


# ── Closed-Loop Status, Diagnostic & Active Recall ─────────────────────────

class DiagnosticSubmitReq(BaseModel):
    user_id: str = "default"
    answers: list[dict] = []


@router.get("/loop/status")
@router.get("/loop/status/", include_in_schema=False)
def get_loop_status(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Return closed-loop learning state, baseline diagnostic status, and concept count."""
    uid = current_user.user_id
    kb = store.get_kb(uid)
    concepts_list = kb.get("concepts", []) if (kb and kb.get("ready")) else []
    if not concepts_list:
        return {
            "ok": True,
            "loop_state": "UNINITIALIZED",
            "state": "AWAITING_UPLOAD",
            "message": "Upload your study material to begin.",
            "material_ready": False,
            "concepts_count": 0,
            "baseline_completed": False,
            "total_attempts": 0,
        }

    snap = mastery.snapshot(uid)
    total_attempts = sum(c.get("attempts", 0) for c in snap)
    lifecycle = loop.get_lifecycle_state(uid)
    baseline_done = (lifecycle == "ACTIVE_LEARNING" or total_attempts >= 3)
    loop_state = "ACTIVE_LOOP" if baseline_done else "BASELINE_DIAGNOSTIC"
    lifecycle_state = "ACTIVE_LEARNING" if baseline_done else lifecycle

    return {
        "ok": True,
        "loop_state": loop_state,
        "state": lifecycle_state,
        "message": "Active learning session in progress." if baseline_done else "Baseline diagnostic required.",
        "material_ready": True,
        "concepts_count": len(concepts_list),
        "baseline_completed": baseline_done,
        "total_attempts": total_attempts,
    }


@router.post("/diagnostic/start")
@router.post("/diagnostic/start/", include_in_schema=False)
def post_diagnostic_start(body: dict | None = None, current_user: User = Depends(get_current_user)):
    """Generate 6-question baseline diagnostic quiz covering the curriculum to baseline knowledge."""
    uid = "default"
    if body and "user_id" in body and body["user_id"] != "default":
        uid = body["user_id"]
    elif current_user and current_user.user_id != "default":
        uid = current_user.user_id

    kb = store.get_kb(uid)
    concepts_list = kb.get("concepts", []) if (kb and kb.get("ready")) else []
    if not concepts_list:
        raise HTTPException(status_code=400, detail="No study materials indexed yet.")

    path = concepts.get_learning_path(unmastered_only=False, user_id=uid) if hasattr(concepts, "get_learning_path") else [c["id"] for c in concepts_list]
    target_cids = list(path[:6])
    while len(target_cids) < 6 and concepts_list:
        target_cids.append(concepts_list[len(target_cids) % len(concepts_list)]["id"])

    questions = []
    seen_qids = set()
    for cid in target_cids:
        try:
            qs = quiz.generate_diagnostic_quiz(cid, count=1)
            for q in qs:
                if q.question_id not in seen_qids:
                    seen_qids.add(q.question_id)
                    qd = q.model_dump()
                    c_meta = next((c for c in concepts_list if c["id"] == cid), {})
                    qd["conceptName"] = c_meta.get("name", cid)
                    qd["conceptId"] = cid
                    questions.append(qd)
                    if len(questions) >= 6:
                        break
        except Exception:
            pass
        if len(questions) >= 6:
            break

    return {
        "ok": True,
        "questions": questions,
        "count": len(questions),
    }


@router.post("/diagnostic/submit")
@router.post("/diagnostic/submit/", include_in_schema=False)
def post_diagnostic_submit(body: DiagnosticSubmitReq, current_user: User = Depends(get_current_user)):
    """Grade baseline diagnostic submissions, update epistemic beliefs, and unlock active loop."""
    uid = body.user_id if body.user_id != "default" else (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    results = []
    correct_count = 0

    for a in body.answers:
        sub = QuizSubmission(
            user_id=uid,
            question_id=a.get("question_id", a.get("id", "diag_sub")),
            concept_id=a.get("concept_id", a.get("conceptId", "")),
            selected_option_idx=a.get("selected_option_idx", a.get("selectedIndex")),
            typed_answer=a.get("typed_answer", a.get("typedAnswer", "")),
            student_reasoning=a.get("student_reasoning", a.get("studentReasoning", "")),
            numeric_answer=a.get("numeric_answer", a.get("numericAnswer")),
        )
        try:
            res = loop.submit_quiz_answer(sub)
            results.append(res)
            if res.get("is_correct"):
                correct_count += 1
        except Exception:
            pass

    total = max(len(body.answers), 1)
    score_pct = round((correct_count / total) * 100)
    return {
        "ok": True,
        "score": score_pct,
        "correct_count": correct_count,
        "total": len(body.answers),
        "baseline_completed": True,
        "results": results,
    }


# ── 7. Universal Multi-Format Study Materials & Interactive Preview ──────────

@router.post("/materials/ingest-file")
@router.post("/materials/ingest-file/")
async def post_materials_ingest_file(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile | None = File(default=None),
    user_id: str = Form("default"),
    title: str | None = Form(None),
    current_user: User = Depends(get_current_user),
):
    """Ingest multi-format study material (.pdf, .pptx, .md, .txt, .docx, .mp3, .wav, .m4a, .webm)."""
    uid = user_id if user_id != "default" else (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    all_uploads: list[UploadFile] = list(files or [])
    if file:
        all_uploads.append(file)

    if not all_uploads:
        raise HTTPException(status_code=400, detail="No study material file provided.")

    allowed_exts = {".pdf", ".pptx", ".ppt", ".md", ".txt", ".docx", ".mp3", ".wav", ".m4a", ".webm"}
    ingested_materials = []

    for f in all_uploads:
        if not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in allowed_exts:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported format '{ext}'. Supported: PDF, PPTX, MD, TXT, DOCX, MP3, WAV, M4A, WEBM."
            )
        await _enforce_content_policy(f, uid)
        dest = config.UPLOAD_DIR / Path(f.filename).name
        content = await f.read()
        dest.write_bytes(content)

        try:
            mat_res = UniversalMaterialIngestor.ingest_file(
                path=dest,
                user_id=uid,
                title=title or Path(f.filename).stem.replace("_", " ").title()
            )
            ingested_materials.append(mat_res)
        except store.UserError as ue:
            raise HTTPException(status_code=400, detail=str(ue))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to ingest file '{f.filename}': {e}")

    active_kb = store.get_kb(uid)
    return {
        "ok": True,
        "count": len(ingested_materials),
        "materials": ingested_materials,
        "active_kb": {
            "ready": active_kb.get("ready", False),
            "title": active_kb.get("file", ""),
            "pages": active_kb.get("pages", 0),
            "concepts": len(active_kb.get("concepts", [])),
        }
    }


@router.post("/materials/ingest-url")
@router.post("/materials/ingest-url/")
async def post_materials_ingest_url(req: IngestUrlRequest, current_user: User = Depends(get_current_user)):
    """Screen the fetched URL payload before it can be persisted or indexed."""
    url = req.url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="URL must begin with http:// or https://")

    uid = req.user_id if req.user_id != "default" else (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    try:
        # Fetch/extract exactly once, without writing to the database or search index.
        # Pass this same payload into ingestion after it passes moderation.
        preview = UniversalMaterialIngestor.preview_url(
            url=url,
            source_type=req.source_type,
            title=req.title,
        )
        extracted_text = preview.get("raw_text", "")
        screening = screen_text(extracted_text)

        if screening.decision == ContentDecision.REVIEW and not screening.matched_signals:
            raise HTTPException(
                status_code=422,
                detail="This URL has no supported extractable text or transcript. It was not retained; manual moderation or OCR is required.",
            )

        if screening.matched_signals and not store.is_medical_verified(uid):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "MEDICAL_VERIFICATION_REQUIRED",
                    "message": "This material contains explicit-content signals. Only verified medical students can access it. Submit your medical student ID and institution-issued email for review.",
                    "verification_endpoint": "/api/auth/medical-verification",
                    "signals": list(screening.matched_signals),
                },
            )

        mat_res = UniversalMaterialIngestor.ingest_url(
            url=url,
            source_type=req.source_type,
            user_id=uid,
            title=req.title,
            preloaded_content=preview,
        )
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to moderate or ingest URL %s", url)
        raise HTTPException(status_code=500, detail=f"Failed to ingest URL '{url}': {e}")

    active_kb = store.get_kb(uid)
    return {
        "ok": True,
        "material": mat_res,
        "active_kb": {
            "ready": active_kb.get("ready", False),
            "title": active_kb.get("file", ""),
            "pages": active_kb.get("pages", 0),
            "concepts": len(active_kb.get("concepts", [])),
        }
    }

@router.get("/materials", response_model=MaterialsListResponse)
@router.get("/materials/", response_model=MaterialsListResponse)
def get_study_materials(user_id: str = "default", current_user: User = Depends(get_current_user)):
    """List all ingested study materials for the learner with metadata badges."""
    uid = user_id if user_id != "default" else (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    materials = store.list_study_materials(user_id=uid)
    models = [StudyMaterialMetadata(**m) for m in materials]
    return MaterialsListResponse(
        materials=models,
        total_materials=len(models),
        total_chunks=sum(m.chunk_count for m in models),
        total_concepts=sum(m.concept_count for m in models),
    )


@router.get("/materials/{material_id}/preview", response_model=StudyMaterialPreview)
@router.get("/materials/{material_id}/preview/", response_model=StudyMaterialPreview)
def get_study_material_preview(material_id: str, current_user: User = Depends(get_current_user)):
    """Return structured preview payload (pages, slides, timestamps, or reader view) for interactive inspection."""
    mat = store.get_study_material(material_id, user_id=current_user.user_id)
    if not mat:
        raise HTTPException(status_code=404, detail=f"Study material '{material_id}' not found.")
    return StudyMaterialPreview(**mat)


@router.delete("/materials/{material_id}")
@router.delete("/materials/{material_id}/")
def delete_study_material(material_id: str, user_id: str = "default", current_user: User = Depends(get_current_user)):
    """Delete a study material and automatically rebuild the unified index and Prerequisite DAG."""
    uid = user_id if user_id != "default" else (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    try:
        res = UniversalMaterialIngestor.delete_material(material_id=material_id, user_id=uid)
        return {
            "ok": True,
            "deleted_material_id": material_id,
            "rebuilt_kb": res
        }
    except store.UserError as ue:
        raise HTTPException(status_code=404, detail=str(ue))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete material: {e}")


# ── Multimodal Artifacts & Smart Study Notes ─────────────────────────────────

@router.get("/artifacts/{filename}")
def get_generated_artifact(filename: str, download: Optional[bool] = None):
    """Serve generated .pdf, .pptx, .svg, and .mp3 files from config.GENERATED_ARTIFACTS_DIR."""
    safe_name = Path(filename).name
    file_path = (config.GENERATED_ARTIFACTS_DIR / safe_name).resolve()
    base_dir = config.GENERATED_ARTIFACTS_DIR.resolve()

    if not file_path.is_file() or not str(file_path).startswith(str(base_dir)):
        raise HTTPException(status_code=404, detail="Artifact not found")

    suffix = file_path.suffix.lower()
    media_types = {
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".mp3": "audio/mpeg",
    }
    media_type = media_types.get(suffix, "application/octet-stream")
    is_attachment = download is True or suffix in [".pdf", ".pptx"]
    if is_attachment:
        return FileResponse(
            path=str(file_path),
            media_type=media_type,
            filename=safe_name,
            content_disposition_type="attachment",
        )
    return FileResponse(path=str(file_path), media_type=media_type)


@router.post("/materials/{material_id}/deep-audio")
@router.post("/materials/{material_id}/deep-audio/")
def post_material_deep_audio(
    material_id: str,
    req: Optional[DeepAudioRequest] = None,
    current_user: User = Depends(get_current_user)
):
    """Generate professor-style deep spoken explanation for a PDF or PPTX slide."""
    uid = (req.user_id if req and req.user_id and req.user_id != "default" else None) or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    section_index = req.section_or_slide_index if req else 0

    mat = store.get_material(material_id, user_id=uid)
    if not mat:
        raise HTTPException(status_code=404, detail=f"Material '{material_id}' not found.")

    try:
        res = tts.generate_deep_material_audio(
            material=mat,
            user_id=uid,
            section_or_slide_index=section_index
        )
        return res
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate deep audio: {e}")


@router.post("/notes/generate", response_model=SmartNoteResponse)
@router.post("/notes/generate/", response_model=SmartNoteResponse)
def post_notes_generate(
    req: SmartNoteRequest,
    current_user: User = Depends(get_current_user)
):
    """Generate smart study notes adhering strictly to task-type specifications."""
    if (not req.user_id or req.user_id == "default") and (current_user and current_user.user_id and current_user.user_id != "default"):
        req.user_id = current_user.user_id

    try:
        res = notes.generate_smart_note(req)
        return res
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate smart note: {e}")


@router.post("/notes/{note_id}/audio")
@router.post("/notes/{note_id}/audio/")
def post_note_audio(
    note_id: str,
    user_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user)
):
    """Synthesize high-yield spoken audio executive summary using ElevenLabs Flash."""
    uid = user_id or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    try:
        res = notes.generate_note_audio(note_id=note_id, user_id=uid)
        return res
    except store.UserError as ue:
        err_msg = str(ue)
        status = 404 if "not found" in err_msg.lower() else 400
        raise HTTPException(status_code=status, detail=err_msg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate note audio: {e}")


@router.post("/notes/{note_id}/export")
@router.post("/notes/{note_id}/export/")
def post_note_export(
    note_id: str,
    export_format: Optional[str] = Query(None),
    payload: Optional[dict] = Body(None),
    user_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user)
):
    """Export a smart note as a PDF study handout or PPTX slide deck."""
    fmt = (export_format or (payload.get("export_format") if isinstance(payload, dict) else None) or "pdf").lower().strip()
    uid = (payload.get("user_id") if isinstance(payload, dict) else None) or user_id or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    try:
        res = notes.export_note_artifact(note_id=note_id, user_id=uid, export_format=fmt)
        return res
    except store.UserError as ue:
        err_msg = str(ue)
        status = 404 if "not found" in err_msg.lower() else 400
        raise HTTPException(status_code=status, detail=err_msg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to export note artifact: {e}")


@router.get("/notes")
@router.get("/notes/")
def get_notes(
    concept_id: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user)
):
    """Retrieve saved smart study notes for the active learner."""
    uid = user_id or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    return store.list_smart_notes(user_id=uid, concept_id=concept_id)


@router.delete("/notes/{note_id}")
@router.delete("/notes/{note_id}/")
def delete_smart_note(
    note_id: str,
    user_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user)
):
    """Delete a saved smart note from the archive."""
    uid = user_id or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    deleted = store.delete_smart_note(note_id=note_id, user_id=uid)
    return {"ok": True, "deleted": deleted, "note_id": note_id}


@router.post("/tools/generate")
@router.post("/tools/generate/")
def post_tools_generate(
    req: ToolGenerateRequest,
    current_user: User = Depends(get_current_user)
):
    """Invoke generative study tools (visual SVG diagram, PPTX deck, PDF handout, curated resources)."""
    uid = (req.user_id if req.user_id and req.user_id != "default" else None) or (current_user.user_id if current_user and current_user.user_id != "default" else "default")
    tool_type = req.tool_type.lower().strip()
    try:
        if tool_type == "visual":
            return tools.generate_visual_diagram_tool(
                concept_id=req.concept_id,
                prompt=req.prompt or "",
                user_id=uid
            )
        elif tool_type == "pptx":
            return tools.generate_pptx_deck_tool(
                concept_id=req.concept_id,
                user_id=uid,
                slide_count=req.slide_count or 5
            )
        elif tool_type == "pdf":
            return tools.generate_pdf_handout_tool(
                concept_id=req.concept_id,
                user_id=uid
            )
        elif tool_type == "resources":
            return tools.suggest_curated_resources_tool(
                concept_id=req.concept_id,
                query=req.prompt or "",
                user_id=uid
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported tool type '{tool_type}'. Must be 'visual', 'pptx', 'pdf', or 'resources'.")
    except store.UserError as ue:
        raise HTTPException(status_code=400, detail=str(ue))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tool generation failed: {e}")


