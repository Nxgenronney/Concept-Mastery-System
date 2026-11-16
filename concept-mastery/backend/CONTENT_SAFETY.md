# Content Safety, Medical Verification & Privacy Architecture

This document describes the closed-loop content safety screening, medical-access policy, SheerID verification integration, and privacy compliance standards for the Concept Mastery Platform.

---

## 1. Automated Multimodal Screening Before Persistence

Content submitted via file upload (`/api/upload`) or URL extraction (`/api/materials/ingest-url`) is screened **strictly before** any data is written to disk or indexed into the SQLite BM25 inverted index.

### Categorical Screening Outcomes
- **`ALLOW`**: Content contains standard educational and academic material without explicit signals. Ingested immediately.
- **`RESTRICTED`**: Material contains explicit sexual or graphic content. Ingestion and retrieval are restricted exclusively to verified medical students (`is_medical_verified(user_id) == True`). Unverified students receive an HTTP `403 MEDICAL_VERIFICATION_REQUIRED` error with a SheerID initiation endpoint.
- **`REVIEW`**: Content with no extractable text (e.g. scanned image PDFs without OCR) or materials containing explicit terms within a recognized educational/clinical context (such as reproductive health, sexual pathology, or STI dermatology).

### De-Obfuscation & Multi-Provider Moderation
- **Text Normalization**: Strips zero-width characters, decomposes unicode ligatures (NFKD), maps leetspeak (`p0rn` &rarr; `porn`, `s3x` &rarr; `sex`), and collapses spaced or punctuated letters (`s.e.x` &rarr; `sex`).
- **OpenAI Moderation API Integration**: When configured via `OPENAI_MODERATION_API_KEY` (or `OPENAI_API_KEY`), queries `/v1/moderations` to evaluate category scores (`sexual`, `sexual/minors`, `violence`).
- **Visual Content Screening**: Embedded images inside `.pdf` and `.pptx` documents are extracted and inspected via `extract_visual_content_for_screening` before persistence.

### Clinical False-Positive Mitigation
Legitimate medical and anatomical education (e.g., histology, urology, gynecology, obstetrics, sexually transmitted infections, pelvic pathology) is protected from blunt false positives via the `_EDUCATIONAL_CONTEXT` ontology filter.

---

## 2. Real SheerID Verification & Webhook Architecture

To eliminate the risks of self-assertion and internal manual review, medical student verification is delegated to **SheerID**:

1. **Eligibility Program Scoping**: Verification is bound to a verified medical student program (`SHEERID_PROGRAM_ID`), ensuring general student status does not grant access to restricted clinical content.
2. **Session Initiation (`POST /api/auth/sheerid/initiate`)**: Initiates a session with SheerID or directs the student to the official hosted verification portal (`https://services.sheerid.com/verify/{programId}/`).
3. **Webhook Authenticity & Signature Verification (`POST /api/auth/sheerid-webhook`)**:
   - Validates webhook authenticity using HMAC-SHA256 signature (`X-SheerID-Signature`) or secret token (`X-SheerID-Token`).
   - Verifies the authoritative state against SheerID's REST API (`GET /rest/v2/verification/{id}`).
4. **Replay Protection & Idempotent Handling**:
   - Every webhook event is registered in `sheerid_webhook_events(event_id, verification_id, event_type, received_at)`.
   - Duplicate or replayed events are logged and rejected with idempotency.
5. **State Transition**: Only `approved` / `success` events mark `status = 'approved'` in `medical_verification_requests`. Pending, rejected, or expired events never unlock restricted materials.

---

## 3. Privacy, PII Elimination & Safe Disposal Plan

### Elimination of Local ID Storage
- **No Local Document Retention**: The application no longer accepts or stores raw student ID cards, photos, or passports on the local filesystem (`data/vectorstore/medical_verification/`). All identity proofing is handled directly by SheerID.
- **Removed Insecure Routes**: The insecure endpoint `/admin/medical-verification/{user_id}/id-card` and manual admin verification routes using static tokens have been completely removed.
- **Minimal Metadata Storage**: The database retains only:
  - `user_id`, `provider` (`sheerid`), `verification_id`, `program_id`, `status`, `submitted_at`, `reviewed_at`.

### Disposal & Migration Procedure for Legacy Records
If legacy development environments contain files under `data/vectorstore/medical_verification/`:
1. **Audit**: Verify no active user study materials reside in the directory (study materials are saved in `data/uploads/`).
2. **Disposal**: Securely unlink any residual identity files:
   ```bash
   python -c "from app.config import MEDICAL_VERIFICATION_DIR; [p.unlink() for p in MEDICAL_VERIFICATION_DIR.glob('*') if p.is_file()]; print('Disposal complete.')"
   ```
3. **Database Cleansing**: Clear legacy `id_card_filename` references from `medical_verification_requests`.

---

## 4. Institutional Mailbox Ownership Verification

Mailbox ownership is strictly differentiated from academic enrollment:
- **Challenge Dispatch (`POST /api/auth/email-verification/request`)**: Issues a cryptographically secure 6-digit numeric OTP with a 15-minute TTL.
- **Salted Hashing**: The OTP is hashed using salted HMAC-SHA256 before storage in `email_verifications`. Plaintext codes are never stored.
- **Rate Limiting & Anti-Replay (`POST /api/auth/email-verification/verify`)**: Maximum 5 attempts per challenge. Verified tokens are immediately invalidated.
- **Non-Privilege Principle**: Verifying control of an `.edu` email address sets `email_ownership_verified = True` but **does not** grant medical student access; medical access requires SheerID program approval.
