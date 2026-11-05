"""Shared knowledge base (index + concepts), SQLite study materials, user auth, and audit log persistence."""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any
from .. import config
from .vector_index import VectorIndex

class UserError(Exception):
    """A problem the user can fix. Becomes a 400 response with this message."""

KB: dict = {"ready": False}
USER_KBS: dict[str, dict] = {}
KB_FILE = config.VECTOR_STORE_PATH / "kb.json"
MASTERY_FILE = config.VECTOR_STORE_PATH / "mastery.json"
MATERIALS_DB_PATH = config.VECTOR_STORE_PATH / "study_materials.db"

_MATERIALS_SCHEMA = """
-- Study Materials
CREATE TABLE IF NOT EXISTS study_materials (
    material_id                 TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL DEFAULT 'default',
    title                       TEXT NOT NULL,
    source_type                 TEXT NOT NULL,
    original_filename_or_url    TEXT NOT NULL,
    raw_extracted_text          TEXT NOT NULL,
    structured_preview_json     TEXT NOT NULL DEFAULT '[]',
    chunk_count                 INTEGER NOT NULL DEFAULT 0,
    extracted_concepts_json     TEXT NOT NULL DEFAULT '[]',
    created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_user ON study_materials(user_id);

-- Registered Users (Google OAuth & Local Dev)
CREATE TABLE IF NOT EXISTS users (
    user_id         TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    full_name       TEXT NOT NULL DEFAULT '',
    picture_url     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    last_login_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- User Login & Session Audit Trail
CREATE TABLE IF NOT EXISTS user_login_logs (
    log_id          TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    logged_in_at    TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON user_login_logs(user_id);

-- Active Recall Sessions
CREATE TABLE IF NOT EXISTS active_recall_sessions (
    session_id                  TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL DEFAULT 'default',
    concept_id                  TEXT NOT NULL,
    timer_seconds               INTEGER NOT NULL DEFAULT 120,
    lesson_json                 TEXT NOT NULL DEFAULT '{}',
    recall_submission_text      TEXT NOT NULL DEFAULT '',
    verification_question_json  TEXT NOT NULL DEFAULT '{}',
    retrieval_score             REAL DEFAULT NULL,
    retained_concepts_json      TEXT NOT NULL DEFAULT '[]',
    missed_gaps_json            TEXT NOT NULL DEFAULT '[]',
    created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_recall_user ON active_recall_sessions(user_id);

-- Smart Notes
CREATE TABLE IF NOT EXISTS smart_notes (
    note_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    material_id TEXT,
    task_type TEXT NOT NULL,
    custom_instructions TEXT,
    title TEXT NOT NULL,
    markdown_content TEXT NOT NULL,
    key_takeaways_json TEXT NOT NULL DEFAULT '[]',
    citations_json TEXT NOT NULL DEFAULT '[]',
    audio_url TEXT,
    pdf_url TEXT,
    pptx_url TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_smart_notes_user_concept ON smart_notes(user_id, concept_id);

-- Learning Evidence Store
CREATE TABLE IF NOT EXISTS learning_evidence_store (
    evidence_id                 TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL DEFAULT 'default',
    concept_id                  TEXT NOT NULL,
    question_id                 TEXT NOT NULL DEFAULT '',
    question_text               TEXT NOT NULL DEFAULT '',
    question_form               TEXT NOT NULL DEFAULT 'quiz',
    student_answer              TEXT NOT NULL DEFAULT '',
    student_explanation         TEXT NOT NULL DEFAULT '',
    problem_solving_approach    TEXT NOT NULL DEFAULT '',
    hints_used                  INTEGER NOT NULL DEFAULT 0,
    solution_revealed_first     INTEGER NOT NULL DEFAULT 0,
    corrected_after_feedback    INTEGER NOT NULL DEFAULT 0,
    is_unfamiliar_example       INTEGER NOT NULL DEFAULT 0,
    session_id                  TEXT,
    created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_evidence_user_concept ON learning_evidence_store(user_id, concept_id);

-- Specialist Agent Findings
CREATE TABLE IF NOT EXISTS specialist_agent_findings (
    finding_id                  TEXT PRIMARY KEY,
    decision_id                 TEXT NOT NULL,
    user_id                     TEXT NOT NULL DEFAULT 'default',
    concept_id                  TEXT NOT NULL,
    agent_role                  TEXT NOT NULL,
    evidence_refs_json          TEXT NOT NULL DEFAULT '[]',
    findings                    TEXT NOT NULL DEFAULT '',
    identified_gaps_json        TEXT NOT NULL DEFAULT '[]',
    recommended_action          TEXT NOT NULL DEFAULT '',
    assessment_confidence       TEXT NOT NULL DEFAULT 'moderate',
    limitations                 TEXT NOT NULL DEFAULT '',
    created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_specialist_findings_decision_user_concept ON specialist_agent_findings(decision_id, user_id, concept_id);

-- Explainable Mastery Decisions
CREATE TABLE IF NOT EXISTS explainable_mastery_decisions (
    decision_id                     TEXT PRIMARY KEY,
    user_id                         TEXT NOT NULL DEFAULT 'default',
    concept_id                      TEXT NOT NULL,
    outcome                         TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
    legacy_status                   TEXT NOT NULL DEFAULT 'UNKNOWN',
    demonstrated_understanding_json TEXT NOT NULL DEFAULT '[]',
    remaining_gaps_json             TEXT NOT NULL DEFAULT '[]',
    unresolved_disagreements_json   TEXT NOT NULL DEFAULT '[]',
    supporting_evidence_refs_json   TEXT NOT NULL DEFAULT '[]',
    recommended_next_action         TEXT NOT NULL DEFAULT '',
    follow_up_question_json         TEXT DEFAULT NULL,
    evidence_version                INTEGER NOT NULL DEFAULT 1,
    evaluation_pending              INTEGER NOT NULL DEFAULT 0,
    updated_at                      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mastery_decisions_user_concept ON explainable_mastery_decisions(user_id, concept_id);

-- Medical learner verification; uploaded ID evidence is stored outside public uploads.
CREATE TABLE IF NOT EXISTS medical_verification_requests (
    user_id TEXT PRIMARY KEY,
    institution TEXT NOT NULL,
    program TEXT NOT NULL,
    educational_email TEXT NOT NULL,
    id_card_filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'rejected')),
    submitted_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_notes TEXT DEFAULT ''
);
"""

@contextmanager
def get_materials_db():
    conn = sqlite3.connect(str(MATERIALS_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def init_materials_db():
    config.VECTOR_STORE_PATH.mkdir(parents=True, exist_ok=True)
    with get_materials_db() as conn:
        conn.executescript(_MATERIALS_SCHEMA)

init_materials_db()

# ── User Account & Session Audit Persistence ────────────────────────────────

def upsert_user(user_id: str, email: str, full_name: str = "", picture_url: str = "") -> dict:
    """Create or update student profile upon Google OAuth sign-in."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_materials_db() as conn:
        existing = conn.execute("SELECT created_at FROM users WHERE user_id = ?", (user_id,)).fetchone()
        created_at = existing["created_at"] if existing else now_iso
        conn.execute(
            """
            INSERT OR REPLACE INTO users (user_id, email, full_name, picture_url, created_at, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, email, full_name or "", picture_url or "", created_at, now_iso)
        )
    return {
        "user_id": user_id,
        "email": email,
        "full_name": full_name or "",
        "picture_url": picture_url or "",
        "created_at": created_at,
        "last_login_at": now_iso,
    }

def get_user(user_id: str) -> dict | None:
    """Lookup student account by user_id."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

def get_user_by_email(email: str) -> dict | None:
    """Lookup student account by verified email."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None

def record_login_log(user_id: str, ip_address: str | None = None, user_agent: str | None = None) -> dict:
    """Record an audit log entry for student login."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    log_id = f"log_{uuid.uuid4().hex[:12]}"
    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT INTO user_login_logs (log_id, user_id, logged_in_at, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?)
            """,
            (log_id, user_id, now_iso, ip_address, user_agent)
        )
    return {
        "log_id": log_id,
        "user_id": user_id,
        "logged_in_at": now_iso,
        "ip_address": ip_address,
        "user_agent": user_agent,
    }

def get_user_login_logs(user_id: str, limit: int = 20) -> list[dict]:
    """Retrieve recent login audit history for user."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            "SELECT * FROM user_login_logs WHERE user_id = ? ORDER BY logged_in_at DESC LIMIT ?",
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]

# ── Study Materials Persistence ─────────────────────────────────────────────

def save_study_material(mat: dict) -> dict:
    """Save or update a study material in the SQLite database."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    material_id = mat.get("material_id") or mat.get("id") or f"mat_{int(datetime.now().timestamp()*1000)}"
    user_id = mat.get("user_id", "default")
    title = mat.get("title") or mat.get("filename") or "Untitled Material"
    source_type = mat.get("source_type", "pdf")
    origin = mat.get("original_filename_or_url") or mat.get("filename") or ""
    raw_text = mat.get("raw_extracted_text") or mat.get("text") or ""
    preview_json = mat.get("structured_preview_json")
    if preview_json is None:
        preview_json = json.dumps(mat.get("structured_preview", []))
    elif not isinstance(preview_json, str):
        preview_json = json.dumps(preview_json)
        
    chunk_count = int(mat.get("chunk_count", 0))
    concepts_json = mat.get("extracted_concepts_json")
    if concepts_json is None:
        concepts_json = json.dumps(mat.get("concepts", []))
    elif not isinstance(concepts_json, str):
        concepts_json = json.dumps(concepts_json)

    created_at = mat.get("created_at") or now_iso

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO study_materials
            (material_id, user_id, title, source_type, original_filename_or_url,
             raw_extracted_text, structured_preview_json, chunk_count,
             extracted_concepts_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                material_id, user_id, title, source_type, origin,
                raw_text, preview_json, chunk_count, concepts_json, created_at
            )
        )
    return {
        "material_id": material_id,
        "user_id": user_id,
        "title": title,
        "source_type": source_type,
        "original_filename_or_url": origin,
        "chunk_count": chunk_count,
        "concepts": json.loads(concepts_json),
        "concept_count": len(json.loads(concepts_json)),
        "created_at": created_at,
    }

def list_study_materials(user_id: str = "default") -> list[dict]:
    """Retrieve all study materials for the given learner."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            """
            SELECT material_id, user_id, title, source_type, original_filename_or_url,
                   chunk_count, extracted_concepts_json, created_at
            FROM study_materials
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (user_id,)
        ).fetchall()
        materials = []
        for r in rows:
            concepts = json.loads(r["extracted_concepts_json"]) if r["extracted_concepts_json"] else []
            materials.append({
                "material_id": r["material_id"],
                "user_id": r["user_id"],
                "title": r["title"],
                "source_type": r["source_type"],
                "original_filename_or_url": r["original_filename_or_url"],
                "chunk_count": r["chunk_count"],
                "concepts": concepts,
                "concept_count": len(concepts),
                "created_at": r["created_at"],
            })
        return materials

def get_study_material(material_id: str, user_id: str | None = None) -> dict | None:
    """Retrieve full details and structured preview for a specific material."""
    init_materials_db()
    with get_materials_db() as conn:
        query = "SELECT * FROM study_materials WHERE material_id = ?"
        params = [material_id]
        if user_id:
            query += " AND user_id = ?"
            params.append(user_id)
        row = conn.execute(query, tuple(params)).fetchone()
        if not row:
            return None
        concepts = json.loads(row["extracted_concepts_json"]) if row["extracted_concepts_json"] else []
        preview = json.loads(row["structured_preview_json"]) if row["structured_preview_json"] else []
        return {
            "material_id": row["material_id"],
            "user_id": row["user_id"],
            "title": row["title"],
            "source_type": row["source_type"],
            "original_filename_or_url": row["original_filename_or_url"],
            "raw_extracted_text": row["raw_extracted_text"],
            "raw_text_snippet": (row["raw_extracted_text"][:600] + "...") if len(row["raw_extracted_text"]) > 600 else row["raw_extracted_text"],
            "structured_preview": preview,
            "chunk_count": row["chunk_count"],
            "concepts": concepts,
            "concept_count": len(concepts),
            "created_at": row["created_at"],
        }

def delete_study_material(material_id: str, user_id: str | None = None) -> bool:
    """Delete a study material by ID, optionally isolated by user_id."""
    init_materials_db()
    with get_materials_db() as conn:
        if user_id:
            res = conn.execute("DELETE FROM study_materials WHERE material_id = ? AND user_id = ?", (material_id, user_id))
        else:
            res = conn.execute("DELETE FROM study_materials WHERE material_id = ?", (material_id,))
        return res.rowcount > 0

def clear_all_study_materials(user_id: str | None = None):
    init_materials_db()
    with get_materials_db() as conn:
        if user_id:
            conn.execute("DELETE FROM study_materials WHERE user_id = ?", (user_id,))
        else:
            conn.execute("DELETE FROM study_materials")


# ── Active Recall Session Persistence ───────────────────────────────────────

def save_active_recall_session(session: dict) -> dict:
    """Save or initialize an active recall session in SQLite."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    session_id = session.get("session_id") or f"ar_{uuid.uuid4().hex[:12]}"
    user_id = session.get("user_id", "default")
    concept_id = session.get("concept_id", "")
    timer_seconds = int(session.get("timer_seconds", 120))

    lesson = session.get("lesson_json", "{}")
    if not isinstance(lesson, str):
        lesson = json.dumps(lesson)

    recall_text = session.get("recall_submission_text", "")

    verification_q = session.get("verification_question_json", "{}")
    if not isinstance(verification_q, str):
        verification_q = json.dumps(verification_q)

    retrieval_score = session.get("retrieval_score")
    if retrieval_score is not None:
        retrieval_score = float(retrieval_score)

    retained = session.get("retained_concepts_json", "[]")
    if not isinstance(retained, str):
        retained = json.dumps(retained)

    missed = session.get("missed_gaps_json", "[]")
    if not isinstance(missed, str):
        missed = json.dumps(missed)

    created_at = session.get("created_at") or now_iso

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO active_recall_sessions
            (session_id, user_id, concept_id, timer_seconds, lesson_json,
             recall_submission_text, verification_question_json, retrieval_score,
             retained_concepts_json, missed_gaps_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id, user_id, concept_id, timer_seconds, lesson,
                recall_text, verification_q, retrieval_score,
                retained, missed, created_at
            )
        )
    return {
        "session_id": session_id,
        "user_id": user_id,
        "concept_id": concept_id,
        "timer_seconds": timer_seconds,
        "lesson_json": lesson,
        "recall_submission_text": recall_text,
        "verification_question_json": verification_q,
        "retrieval_score": retrieval_score,
        "retained_concepts_json": retained,
        "missed_gaps_json": missed,
        "created_at": created_at,
    }


def update_active_recall_session(session_id: str, updates: dict) -> dict | None:
    """Update an existing active recall session with student submission and AI evaluation."""
    init_materials_db()
    existing = get_active_recall_session(session_id)
    if not existing:
        return None

    for k, v in updates.items():
        if k in ("lesson_json", "verification_question_json", "retained_concepts_json", "missed_gaps_json") and not isinstance(v, str):
            existing[k] = json.dumps(v)
        else:
            existing[k] = v

    with get_materials_db() as conn:
        conn.execute(
            """
            UPDATE active_recall_sessions
            SET recall_submission_text = ?,
                retrieval_score = ?,
                retained_concepts_json = ?,
                missed_gaps_json = ?,
                lesson_json = ?,
                verification_question_json = ?
            WHERE session_id = ?
            """,
            (
                existing["recall_submission_text"],
                existing["retrieval_score"],
                existing["retained_concepts_json"] if isinstance(existing["retained_concepts_json"], str) else json.dumps(existing["retained_concepts_json"]),
                existing["missed_gaps_json"] if isinstance(existing["missed_gaps_json"], str) else json.dumps(existing["missed_gaps_json"]),
                existing["lesson_json"] if isinstance(existing["lesson_json"], str) else json.dumps(existing["lesson_json"]),
                existing["verification_question_json"] if isinstance(existing["verification_question_json"], str) else json.dumps(existing["verification_question_json"]),
                session_id
            )
        )
    return get_active_recall_session(session_id)


def get_active_recall_session(session_id: str) -> dict | None:
    """Fetch an active recall session by session_id."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute("SELECT * FROM active_recall_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if not row:
            return None
        return dict(row)


def list_active_recall_sessions(user_id: str = "default", limit: int = 50) -> list[dict]:
    """Retrieve list of active recall sessions for user_id."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM active_recall_sessions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]

# ── Smart Notes Persistence ─────────────────────────────────────────────────

def save_smart_note(note_data: dict) -> dict:
    """Save or update a smart note in SQLite."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    note_id = note_data.get("note_id") or f"sn_{uuid.uuid4().hex[:12]}"
    user_id = note_data.get("user_id", "default")
    concept_id = note_data.get("concept_id", "")
    material_id = note_data.get("material_id")
    task_type = note_data.get("task_type", "exam")
    custom_instructions = note_data.get("custom_instructions")
    title = note_data.get("title") or "Smart Note"
    markdown_content = note_data.get("markdown_content") or ""

    key_takeaways_json = note_data.get("key_takeaways_json")
    if key_takeaways_json is None:
        key_takeaways_json = json.dumps(note_data.get("key_takeaways", []))
    elif not isinstance(key_takeaways_json, str):
        key_takeaways_json = json.dumps(key_takeaways_json)

    citations_json = note_data.get("citations_json")
    if citations_json is None:
        citations_json = json.dumps(note_data.get("citations", []))
    elif not isinstance(citations_json, str):
        citations_json = json.dumps(citations_json)

    audio_url = note_data.get("audio_url")
    pdf_url = note_data.get("pdf_url")
    pptx_url = note_data.get("pptx_url")
    created_at = note_data.get("created_at") or now_iso

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO smart_notes
            (note_id, user_id, concept_id, material_id, task_type,
             custom_instructions, title, markdown_content,
             key_takeaways_json, citations_json,
             audio_url, pdf_url, pptx_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                note_id, user_id, concept_id, material_id, task_type,
                custom_instructions, title, markdown_content,
                key_takeaways_json, citations_json,
                audio_url, pdf_url, pptx_url, created_at
            )
        )
    return {
        "note_id": note_id,
        "user_id": user_id,
        "concept_id": concept_id,
        "material_id": material_id,
        "task_type": task_type,
        "custom_instructions": custom_instructions,
        "title": title,
        "markdown_content": markdown_content,
        "key_takeaways": json.loads(key_takeaways_json),
        "key_takeaways_json": key_takeaways_json,
        "citations": json.loads(citations_json),
        "citations_json": citations_json,
        "audio_url": audio_url,
        "pdf_url": pdf_url,
        "pptx_url": pptx_url,
        "created_at": created_at,
    }


def get_smart_note(note_id: str, user_id: str = "default") -> Optional[dict]:
    """Fetch a smart note by note_id, isolating by user_id with fallback."""
    init_materials_db()
    with get_materials_db() as conn:
        row = None
        if user_id:
            row = conn.execute(
                "SELECT * FROM smart_notes WHERE note_id = ? AND user_id = ?",
                (note_id, user_id)
            ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT * FROM smart_notes WHERE note_id = ?",
                (note_id,)
            ).fetchone()
        if not row:
            return None
        res = dict(row)
        try:
            res["key_takeaways"] = json.loads(res.get("key_takeaways_json") or "[]")
        except Exception:
            res["key_takeaways"] = []
        try:
            res["citations"] = json.loads(res.get("citations_json") or "[]")
        except Exception:
            res["citations"] = []
        return res


def list_smart_notes(user_id: str = "default", concept_id: Optional[str] = None) -> list[dict]:
    """Retrieve all smart notes for user_id, optionally filtered by concept_id."""
    init_materials_db()
    with get_materials_db() as conn:
        query = "SELECT * FROM smart_notes WHERE 1=1"
        params = []
        if user_id:
            query += " AND user_id = ?"
            params.append(user_id)
        if concept_id:
            query += " AND (concept_id = ? OR LOWER(concept_id) = LOWER(?))"
            params.extend([concept_id, concept_id])
        query += " ORDER BY created_at DESC"
        rows = conn.execute(query, tuple(params)).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            try:
                d["key_takeaways"] = json.loads(d.get("key_takeaways_json") or "[]")
            except Exception:
                d["key_takeaways"] = []
            try:
                d["citations"] = json.loads(d.get("citations_json") or "[]")
            except Exception:
                d["citations"] = []
            results.append(d)
        return results


def delete_smart_note(note_id: str, user_id: str = "default") -> bool:
    """Delete a smart note by ID."""
    init_materials_db()
    with get_materials_db() as conn:
        if user_id:
            res = conn.execute("DELETE FROM smart_notes WHERE note_id = ? AND user_id = ?", (note_id, user_id))
            if res.rowcount == 0:
                res = conn.execute("DELETE FROM smart_notes WHERE note_id = ?", (note_id,))
        else:
            res = conn.execute("DELETE FROM smart_notes WHERE note_id = ?", (note_id,))
        return res.rowcount > 0


def update_smart_note_urls(
    note_id: str,
    user_id: str = "default",
    audio_url: Optional[str] = None,
    pdf_url: Optional[str] = None,
    pptx_url: Optional[str] = None
) -> bool:
    """Update artifact URLs for a smart note."""
    init_materials_db()
    updates = []
    params = []
    if audio_url is not None:
        updates.append("audio_url = ?")
        params.append(audio_url)
    if pdf_url is not None:
        updates.append("pdf_url = ?")
        params.append(pdf_url)
    if pptx_url is not None:
        updates.append("pptx_url = ?")
        params.append(pptx_url)

    if not updates:
        return False

    with get_materials_db() as conn:
        sql = f"UPDATE smart_notes SET {', '.join(updates)} WHERE note_id = ?"
        params_with_id = list(params) + [note_id]
        if user_id:
            res = conn.execute(sql + " AND user_id = ?", tuple(params_with_id + [user_id]))
            if res.rowcount > 0:
                return True
        res = conn.execute(sql, tuple(params_with_id))
        return res.rowcount > 0


# ── Multi-Agent Evidence & Deliberation Persistence ─────────────────────────

def save_learning_evidence(rec: dict | Any) -> dict:
    """Save or update a student learning evidence record."""
    init_materials_db()
    if hasattr(rec, "model_dump"):
        data = rec.model_dump()
    elif isinstance(rec, dict):
        data = dict(rec)
    else:
        data = getattr(rec, "__dict__", {}).copy()

    now_iso = datetime.now(timezone.utc).isoformat()
    evidence_id = data.get("evidence_id") or f"evi_{uuid.uuid4().hex[:12]}"
    user_id = data.get("user_id") or "default"
    concept_id = data.get("concept_id", "")
    question_id = data.get("question_id") or ""
    question_text = data.get("question_text") or ""
    question_form = data.get("question_form") or "quiz"
    student_answer = data.get("student_answer") or ""
    student_explanation = data.get("student_explanation") or ""
    problem_solving_approach = data.get("problem_solving_approach") or ""
    hints_used = int(data.get("hints_used", 0) or 0)
    solution_revealed_first = 1 if data.get("solution_revealed_first") else 0
    corrected_after_feedback = 1 if data.get("corrected_after_feedback") else 0
    is_unfamiliar_example = 1 if data.get("is_unfamiliar_example") else 0
    session_id = data.get("session_id")
    created_at = data.get("created_at") or now_iso

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO learning_evidence_store
            (evidence_id, user_id, concept_id, question_id, question_text,
             question_form, student_answer, student_explanation, problem_solving_approach,
             hints_used, solution_revealed_first, corrected_after_feedback,
             is_unfamiliar_example, session_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                evidence_id, user_id, concept_id, question_id, question_text,
                question_form, student_answer, student_explanation, problem_solving_approach,
                hints_used, solution_revealed_first, corrected_after_feedback,
                is_unfamiliar_example, session_id, created_at
            )
        )

    return {
        "evidence_id": evidence_id,
        "user_id": user_id,
        "concept_id": concept_id,
        "question_id": question_id,
        "question_text": question_text,
        "question_form": question_form,
        "student_answer": student_answer,
        "student_explanation": student_explanation,
        "problem_solving_approach": problem_solving_approach,
        "hints_used": hints_used,
        "solution_revealed_first": bool(solution_revealed_first),
        "corrected_after_feedback": bool(corrected_after_feedback),
        "is_unfamiliar_example": bool(is_unfamiliar_example),
        "session_id": session_id,
        "created_at": created_at,
    }


def get_learning_evidence(evidence_id: str, user_id: str = "default") -> dict | None:
    """Fetch a single learning evidence record by ID and user_id."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute(
            "SELECT * FROM learning_evidence_store WHERE evidence_id = ? AND user_id = ?",
            (evidence_id, user_id)
        ).fetchone()
        if not row:
            return None
        res = dict(row)
        res["solution_revealed_first"] = bool(res.get("solution_revealed_first", 0))
        res["corrected_after_feedback"] = bool(res.get("corrected_after_feedback", 0))
        res["is_unfamiliar_example"] = bool(res.get("is_unfamiliar_example", 0))
        return res


def list_learning_evidence(user_id: str, concept_id: str, limit: int = 50) -> list[dict]:
    """Retrieve chronologically ordered (most recent first) learning evidence records for a concept."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM learning_evidence_store
            WHERE user_id = ? AND concept_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, concept_id, limit)
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["solution_revealed_first"] = bool(d.get("solution_revealed_first", 0))
            d["corrected_after_feedback"] = bool(d.get("corrected_after_feedback", 0))
            d["is_unfamiliar_example"] = bool(d.get("is_unfamiliar_example", 0))
            results.append(d)
        return results


def save_specialist_finding(finding: dict | Any, decision_id: str, user_id: str = "default") -> dict:
    """Save an assessment finding produced by a specialist agent during deliberation."""
    init_materials_db()
    if hasattr(finding, "model_dump"):
        data = finding.model_dump()
    elif isinstance(finding, dict):
        data = dict(finding)
    else:
        data = getattr(finding, "__dict__", {}).copy()

    now_iso = datetime.now(timezone.utc).isoformat()
    finding_id = data.get("finding_id") or f"find_{uuid.uuid4().hex[:12]}"
    uid = data.get("user_id") or user_id
    concept_id = data.get("concept_id", "")
    agent_role = data.get("agent_role", "")
    findings = data.get("findings", "")
    recommended_action = data.get("recommended_action", "")
    assessment_confidence = data.get("assessment_confidence", "moderate")
    limitations = data.get("limitations", "")
    created_at = data.get("created_at") or now_iso

    evidence_refs = data.get("evidence_refs", [])
    if isinstance(evidence_refs, str):
        evidence_refs_json = evidence_refs
        try:
            evidence_refs = json.loads(evidence_refs)
        except Exception:
            evidence_refs = []
    else:
        evidence_refs_json = json.dumps(evidence_refs or [])

    identified_gaps = data.get("identified_gaps", [])
    if isinstance(identified_gaps, str):
        identified_gaps_json = identified_gaps
        try:
            identified_gaps = json.loads(identified_gaps)
        except Exception:
            identified_gaps = []
    else:
        identified_gaps_json = json.dumps(identified_gaps or [])

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO specialist_agent_findings
            (finding_id, decision_id, user_id, concept_id, agent_role,
             evidence_refs_json, findings, identified_gaps_json,
             recommended_action, assessment_confidence, limitations, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                finding_id, decision_id, uid, concept_id, agent_role,
                evidence_refs_json, findings, identified_gaps_json,
                recommended_action, assessment_confidence, limitations, created_at
            )
        )

    return {
        "finding_id": finding_id,
        "decision_id": decision_id,
        "user_id": uid,
        "concept_id": concept_id,
        "agent_role": agent_role,
        "evidence_refs": evidence_refs,
        "evidence_refs_json": evidence_refs_json,
        "findings": findings,
        "identified_gaps": identified_gaps,
        "identified_gaps_json": identified_gaps_json,
        "recommended_action": recommended_action,
        "assessment_confidence": assessment_confidence,
        "limitations": limitations,
        "created_at": created_at,
    }


def list_specialist_findings(decision_id: str, user_id: str = "default") -> list[dict]:
    """Retrieve all specialist agent findings associated with a deliberation decision."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM specialist_agent_findings
            WHERE decision_id = ? AND user_id = ?
            ORDER BY created_at ASC
            """,
            (decision_id, user_id)
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            try:
                d["evidence_refs"] = json.loads(d.get("evidence_refs_json") or "[]")
            except Exception:
                d["evidence_refs"] = []
            try:
                d["identified_gaps"] = json.loads(d.get("identified_gaps_json") or "[]")
            except Exception:
                d["identified_gaps"] = []
            results.append(d)
        return results


def save_mastery_decision(decision: dict | Any, user_id: str = "default") -> dict:
    """Save an explainable mastery decision from the Head Teacher agent."""
    init_materials_db()
    if hasattr(decision, "model_dump"):
        data = decision.model_dump()
    elif isinstance(decision, dict):
        data = dict(decision)
    else:
        data = getattr(decision, "__dict__", {}).copy()

    now_iso = datetime.now(timezone.utc).isoformat()
    decision_id = data.get("decision_id") or f"dec_{uuid.uuid4().hex[:12]}"
    uid = data.get("user_id") or user_id
    concept_id = data.get("concept_id", "")
    outcome = data.get("outcome") or "INSUFFICIENT_EVIDENCE"
    legacy_status = data.get("legacy_status") or "UNKNOWN"

    dem_under = data.get("demonstrated_understanding", [])
    dem_under_json = dem_under if isinstance(dem_under, str) else json.dumps(dem_under or [])

    rem_gaps = data.get("remaining_gaps", [])
    rem_gaps_json = rem_gaps if isinstance(rem_gaps, str) else json.dumps(rem_gaps or [])

    unres_dis = data.get("unresolved_disagreements", [])
    unres_dis_json = unres_dis if isinstance(unres_dis, str) else json.dumps(unres_dis or [])

    supp_refs = data.get("supporting_evidence_refs", [])
    supp_refs_json = supp_refs if isinstance(supp_refs, str) else json.dumps(supp_refs or [])

    rec_next = data.get("recommended_next_action") or ""

    fu_q = data.get("follow_up_question")
    fu_q_json = fu_q if isinstance(fu_q, str) or fu_q is None else json.dumps(fu_q)

    evidence_version = int(data.get("evidence_version", 1) or 1)
    evaluation_pending = 1 if data.get("evaluation_pending") else 0
    updated_at = data.get("updated_at") or now_iso
    explainable_summary = data.get("explainable_summary") or ""

    with get_materials_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO explainable_mastery_decisions
            (decision_id, user_id, concept_id, outcome, legacy_status,
             demonstrated_understanding_json, remaining_gaps_json,
             unresolved_disagreements_json, supporting_evidence_refs_json,
             recommended_next_action, follow_up_question_json,
             evidence_version, evaluation_pending, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                decision_id, uid, concept_id, outcome, legacy_status,
                dem_under_json, rem_gaps_json,
                unres_dis_json, supp_refs_json,
                rec_next, fu_q_json,
                evidence_version, evaluation_pending, updated_at
            )
        )

    def _parse(val, default):
        if val is None:
            return default
        if isinstance(val, (list, dict)):
            return val
        try:
            return json.loads(val)
        except Exception:
            return default

    return {
        "decision_id": decision_id,
        "user_id": uid,
        "concept_id": concept_id,
        "outcome": outcome,
        "legacy_status": legacy_status,
        "demonstrated_understanding": _parse(dem_under_json, []),
        "remaining_gaps": _parse(rem_gaps_json, []),
        "unresolved_disagreements": _parse(unres_dis_json, []),
        "supporting_evidence_refs": _parse(supp_refs_json, []),
        "recommended_next_action": rec_next,
        "follow_up_question": _parse(fu_q_json, None) if fu_q_json else None,
        "evidence_version": evidence_version,
        "evaluation_pending": bool(evaluation_pending),
        "updated_at": updated_at,
        "explainable_summary": explainable_summary,
    }


def get_latest_mastery_decision(user_id: str, concept_id: str) -> dict | None:
    """Fetch the latest explainable mastery decision for a given user and concept."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute(
            """
            SELECT * FROM explainable_mastery_decisions
            WHERE user_id = ? AND concept_id = ?
            ORDER BY updated_at DESC, evidence_version DESC
            LIMIT 1
            """,
            (user_id, concept_id)
        ).fetchone()
        if not row:
            return None
        res = dict(row)
        for key in ("demonstrated_understanding", "remaining_gaps", "unresolved_disagreements", "supporting_evidence_refs"):
            json_key = f"{key}_json"
            try:
                res[key] = json.loads(res.get(json_key) or "[]")
            except Exception:
                res[key] = []
        fu_key = "follow_up_question_json"
        if res.get(fu_key):
            try:
                res["follow_up_question"] = json.loads(res[fu_key])
            except Exception:
                res["follow_up_question"] = None
        else:
            res["follow_up_question"] = None
        res["evaluation_pending"] = bool(res.get("evaluation_pending", 0))
        res["explainable_summary"] = res.get("explainable_summary", "")
        return res


def list_latest_mastery_decisions(user_id: str) -> list[dict]:
    """Retrieve the latest explainable mastery decision for each concept for the user."""
    init_materials_db()
    with get_materials_db() as conn:
        query = """
            WITH Ranked AS (
                SELECT *,
                       ROW_NUMBER() OVER (
                           PARTITION BY concept_id
                           ORDER BY updated_at DESC, evidence_version DESC
                       ) as rn
                FROM explainable_mastery_decisions
                WHERE user_id = ?
            )
            SELECT * FROM Ranked WHERE rn = 1 ORDER BY updated_at DESC
        """
        rows = conn.execute(query, (user_id,)).fetchall()
        decisions = []
        for r in rows:
            res = dict(r)
            res.pop("rn", None)
            for key in ("demonstrated_understanding", "remaining_gaps", "unresolved_disagreements", "supporting_evidence_refs"):
                json_key = f"{key}_json"
                try:
                    res[key] = json.loads(res.get(json_key) or "[]")
                except Exception:
                    res[key] = []
            fu_key = "follow_up_question_json"
            if res.get(fu_key):
                try:
                    res["follow_up_question"] = json.loads(res[fu_key])
                except Exception:
                    res["follow_up_question"] = None
            else:
                res["follow_up_question"] = None
            res["evaluation_pending"] = bool(res.get("evaluation_pending", 0))
            res["explainable_summary"] = res.get("explainable_summary", "")
            decisions.append(res)
        return decisions


def verify_evidence_refs(user_id: str, concept_id: str, claimed_refs: list[str]) -> list[str]:
    """Deterministically checks learning_evidence_store for user_id and concept_id.
    Only returns refs that genuinely exist for that user and concept. Fabricated or cross-tenant IDs are strictly omitted.
    """
    if not claimed_refs:
        return []
    init_materials_db()
    clean_refs = [r for r in claimed_refs if r and isinstance(r, str)]
    if not clean_refs:
        return []
    unique_refs = list(dict.fromkeys(clean_refs))
    placeholders = ",".join("?" for _ in unique_refs)
    with get_materials_db() as conn:
        query = f"""
            SELECT evidence_id FROM learning_evidence_store
            WHERE user_id = ? AND concept_id = ? AND evidence_id IN ({placeholders})
        """
        params = [user_id, concept_id] + unique_refs
        rows = conn.execute(query, tuple(params)).fetchall()
        valid_set = {r["evidence_id"] for r in rows}
        return [ref for ref in unique_refs if ref in valid_set]


# ── Knowledge Base Per-User Management ──────────────────────────────────────

def save_kb(file, pages, index, concepts, edges, user_id: str = "default"):
    """Save knowledge base state isolated to user_id."""
    kb_data = {
        "ready": True,
        "file": file,
        "pages": pages,
        "index": index,
        "concepts": concepts,
        "edges": edges,
        "user_id": user_id,
    }
    USER_KBS[user_id] = kb_data
    if user_id == "default":
        KB.update(kb_data)

def get_kb(user_id: str = "default") -> dict:
    """Retrieve user-specific knowledge base, or empty structure if no materials."""
    if user_id == "default":
        # If store.KB has been explicitly cleared (e.g. by _EmptyKB in test fixtures), respect it
        if not KB.get("ready"):
            return KB
        if "default" in USER_KBS and USER_KBS["default"].get("ready"):
            return USER_KBS["default"]
        mats = list_study_materials("default")
        if mats:
            from ..pipelines.ingest import UniversalMaterialIngestor
            UniversalMaterialIngestor.rebuild_unified_knowledge_base(user_id="default")
            return USER_KBS.get("default", KB)
        return KB

    # For specific non-default user:
    if user_id in USER_KBS and USER_KBS[user_id].get("ready"):
        return USER_KBS[user_id]

    # Check if materials exist in database for this user
    mats = list_study_materials(user_id)
    if mats:
        # Rebuild user's knowledge base dynamically from their materials
        from ..pipelines.ingest import UniversalMaterialIngestor
        UniversalMaterialIngestor.rebuild_unified_knowledge_base(user_id=user_id)
        return USER_KBS.get(user_id, {"ready": False, "file": None, "pages": 0, "index": None, "concepts": [], "edges": [], "user_id": user_id})

    # If the user has explicitly empty or reset KB (e.g. via clear_kb), respect it
    if user_id in USER_KBS and not USER_KBS[user_id].get("ready"):
        return USER_KBS[user_id]

    # Test fixture fallback: if user has no materials of their own, but test fixture loaded KB into default/store.KB
    if USER_KBS.get("default", {}).get("ready") and KB.get("ready"):
        return USER_KBS["default"]
    if KB.get("ready"):
        return KB

    empty = {
        "ready": False,
        "file": None,
        "pages": 0,
        "index": None,
        "concepts": [],
        "edges": [],
        "user_id": user_id
    }
    USER_KBS[user_id] = empty
    return empty

def clear_kb(user_id: str = "default"):
    """Reset knowledge base for a specific user."""
    empty = {
        "ready": False,
        "file": None,
        "pages": 0,
        "index": None,
        "concepts": [],
        "edges": [],
        "user_id": user_id
    }
    USER_KBS[user_id] = empty
    if user_id == "default":
        KB.update(empty)

def load_kb():
    """No-op on startup: ensures clean unpopulated boot without auto-loading default sample."""
    pass

def require(user_id: str = "default"):
    """Assert that the user has ingested study material."""
    kb = get_kb(user_id)
    if not kb.get("ready") or not kb.get("concepts"):
        raise UserError("Upload a study PDF or material first (Study material page).")
    return kb

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def save_json(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def submit_medical_verification_request(user_id: str, institution: str, program: str, educational_email: str, id_card_filename: str) -> dict:
    """Create or refresh a pending medical-student verification request."""
    init_materials_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_materials_db() as conn:
        conn.execute(
            """INSERT INTO medical_verification_requests
               (user_id, institution, program, educational_email, id_card_filename, status, submitted_at, reviewed_at, reviewed_by, review_notes)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, '')
               ON CONFLICT(user_id) DO UPDATE SET
                 institution=excluded.institution, program=excluded.program,
                 educational_email=excluded.educational_email,
                 id_card_filename=excluded.id_card_filename, status='pending',
                 submitted_at=excluded.submitted_at, reviewed_at=NULL,
                 reviewed_by=NULL, review_notes=''""",
            (user_id, institution, program, educational_email.lower().strip(), id_card_filename, now_iso),
        )
    return get_medical_verification_request(user_id) or {}


def get_medical_verification_request(user_id: str) -> dict | None:
    """Return a learner's medical-verification status (never the ID file bytes)."""
    init_materials_db()
    with get_materials_db() as conn:
        row = conn.execute(
            """SELECT user_id, institution, program, educational_email, status,
                      submitted_at, reviewed_at, reviewed_by, review_notes
               FROM medical_verification_requests WHERE user_id=?""",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None


def list_medical_verification_requests() -> list[dict]:
    """List verification requests for authorized manual reviewers."""
    init_materials_db()
    with get_materials_db() as conn:
        rows = conn.execute(
            """SELECT user_id, institution, program, educational_email, id_card_filename,
                      status, submitted_at FROM medical_verification_requests
               ORDER BY submitted_at ASC"""
        ).fetchall()
        return [dict(row) for row in rows]


def review_medical_verification_request(user_id: str, status: str, reviewer: str, notes: str = "") -> dict | None:
    """Approve/reject a request after independent ID-card and institution-email checks."""
    if status not in {"verified", "rejected"}:
        raise ValueError("status must be 'verified' or 'rejected'")
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_materials_db() as conn:
        conn.execute(
            """UPDATE medical_verification_requests
               SET status=?, reviewed_at=?, reviewed_by=?, review_notes=?
               WHERE user_id=?""",
            (status, now_iso, reviewer, notes[:1000], user_id),
        )
    return get_medical_verification_request(user_id)


def is_medical_verified(user_id: str) -> bool:
    """Return True only after an authorized reviewer has approved the learner."""
    request = get_medical_verification_request(user_id)
    return bool(request and request.get("status") == "verified")
