# Closed-Loop Concept Mastery Platform

A production-grade, closed-loop educational mastery platform that solves the fundamental limitations of baseline TutorLLM architectures:
1. **Universal Multi-Format Ingestion**: Ingests textbooks (PDF), slide decks (PPTX), markdown notes (MD), word docs (DOCX), YouTube video lectures, educational web articles (e.g. GeeksforGeeks), and student voice lecture notes with rich interactive previews.
2. **Vectorless RAG**: 100% dense-vector-free retrieval using section-based structural chunking, synonym normalization, and an inverted SQLite/BM25 index with exact dynamic citation anchors (`[Page X]`, `[Slide X]`, `[Timestamp MM:SS]`, `[Web Section]`).
3. **Prerequisite Concept Graph (DAG)**: Automated concept extraction and dependency mining via NetworkX, cycle breaking by earliest appearance, and topological learning path generation scoped per authenticated learner.
4. **Multi-Agent Pedagogical Assessment & Head Teacher Arbiter**: Replaces crude numerical scoring and static formulas with an evidence-backed 6-layer assessment team (Teaching Agent, Assessment Agent, Misconception Detective, Learning Observer, and Head Teacher Arbiter) evaluating authentic student explanations, independent application, and longitudinal progress.
5. **OpenRouter Unified LLM Gateway & NVIDIA Frontier Fallback**: Multi-model auto-failover across primary Google Gemini 2.5 Flash and NVIDIA frontier reasoning models (`nemotron-3-ultra-550b`, `nemotron-3.5-super-vl`, DeepSeek V3, Llama 3.3) with automated `<think>` block sanitization.
6. **Google OAuth 2.0 Multi-Tenancy**: Complete student account isolation, session JWT issuance, login audit logging, and zero-state empty gating.
7. **First-Run Baseline Diagnostic**: Calibrated 6-question baseline assessment across root and foundational DAG nodes to map prior knowledge before unlocking individual concept practice.
8. **Numerical Step-by-Step Questions**: Full calculation/math problem support with given parameter grids, formula hints, tolerance-based grading, and step-by-step arithmetic derivations.
9. **4-Stage Active Recall Engine**: Dedicated sidebar interactive learning loop: Teach Phase (structured Study Card) &rarr; Timed Focus Countdown (1m, 3m, 5m) &rarr; Notes-Hidden Blind Retrieval &rarr; AI Gap Audit & Epistemic Mastery Update.
10. **Two-Layer Socratic Guardrails**: Pedagogical scaffolding that prevents direct answer blurting while enforcing strict citation grounding.
11. **Closed-Loop LangGraph Engine**: Automated agentic cycle of Assessment &rarr; Diagnosis &rarr; Socratic Remediation &rarr; Re-assessment.

---

## Architecture Overview
```
                      PROPOSED CLOSED-LOOP ARCHITECTURE
                      
   Universal Study Materials (PDF, PPTX, MD, DOCX, YouTube, Web, Audio)
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Universal Material Ingestor & Synonym Normalizer (rapidfuzz) │
   └───────────────┬──────────────────────────────┬───────────────┘
                   │                              │
                   ▼                              ▼
   ┌──────────────────────────────┐┌──────────────────────────────┐
   │  Vectorless Inverted Index   ││  Prerequisite Concept Graph  │
   │  SQLite/BM25 Dynamic Anchors ││  NetworkX DAG + Cycle Breaker│
   │  [Page X], [Slide X], [MM:SS]││  Multi-Tenant Scoped per User│
   └───────────────┬──────────────┘└──────────────┬───────────────┘
                   │                              │
                   └──────────────┬───────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │  Baseline Diagnostic Gate │
                    │  (Foundational Calibration)
                    └─────────────┬─────────────┘
                                  │
                                  ▼
     ┌────────────────────────────┴───────────────────────────┐
     ▼                                                        ▼
┌───────────────────────────┐                            ┌───────────────────────────┐
│ Grounded Socratic Tutor   │                            │ 4-Stage Active Recall     │
│ & Diagnostic Quiz Engine  │                            │ (Teach -> Timer -> Blind  │
│ (MCQ, FITB, Q&A, Numeric) │                            │  Retrieval -> Gap Audit)  │
└─────────────┬─────────────┘                            └─────────────┬─────────────┘
              │                                                        │
              └───────────────────────────┬────────────────────────────┘
                                          ▼
                      ┌───────────────────────────────────────┐
                      │        Learning Evidence Store        │
                      │ (SQLite `learning_evidence_store` DB) │
                      └───────────────────┬───────────────────┘
                                          │
        ┌───────────────────┬─────────────┴───────┬───────────────────┐
        ▼                   ▼                     ▼                   ▼
┌──────────────┐    ┌──────────────┐      ┌──────────────┐    ┌──────────────┐
│  👩‍🏫 Teacher   │    │ 🎯 Assessment│      │ 🕵️ Detective  │    │ 📈 Observer   │
│    Agent     │    │    Agent     │      │(Misconception)│   │  (Progress)  │
└──────┬───────┘    └──────┬───────┘      └──────┬───────┘    └──────┬───────┘
       │                   │                     │                   │
       └───────────────────┼─────────────────────┴───────────────────┘
                           ▼
              ┌───────────────────────────┐
              │ Reference ID Validator    │
              │ (`verify_evidence_refs`)  │
              └─────────────┬─────────────┘
                            ▼
              ┌───────────────────────────┐
              │ Head Teacher / Arbiter    │
              │ (Qualitative Deliberation │
              │  & Evidence Verification) │
              └─────────────┬─────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │ Explainable Dashboard &   │
              │ Deliberation Inspector    │
              │ (MASTERED, WEAK, UNKNOWN) │
              └───────────────────────────┘
```

---

## 🤖 Running with Google Antigravity

This repository is optimized for development and pairing with **Google Antigravity**:

- **Setup Guide**: [`antigravity-setup/README.md`](antigravity-setup/README.md) &mdash; Step-by-step setup after cloning onto your desktop.
- **Copy-Paste Prompts**: [`antigravity-setup/PROMPTS.md`](antigravity-setup/PROMPTS.md) &mdash; Ready-to-use prompts to immediately ask Antigravity to run pre-flight checks, launch servers, run active recall sessions, and generate smart study notes.
- **Automated Script**: Run `./antigravity-setup/setup.sh` inside the Antigravity terminal for 1-click venv creation and dependency installation.
- **Native Agent Rules**: Pre-configured in [`.agent/rules/concept-mastery.md`](.agent/rules/concept-mastery.md).

---

## Repository Structure

```text
Concept-Mastery-System/
├── antigravity-setup/           # Google Antigravity onboarding & prompts
│   ├── README.md                # Desktop & Antigravity setup instructions
│   ├── PROMPTS.md               # Ready-to-use prompts for Antigravity agent
│   └── setup.sh                 # One-click environment bootstrap script
├── .agent/rules/                # Native Antigravity agent guidelines
├── screenshots/                 # UI screenshots of the platform
└── concept-mastery/             # Full application stack
    ├── backend/                 # FastAPI backend application
    │   ├── app/
    │   │   ├── core/            # Normalizer, vectorless index, auth, persistence
    │   │   │   ├── auth.py          # Google OAuth 2.0 & JWT session management
    │   │   │   ├── concept_index.py # SQLite BM25 inverted index
    │   │   │   ├── llm.py           # OpenRouter gateway & response sanitizer
    │   │   │   ├── store.py         # SQLite materials, users, logs & sessions
    │   │   │   ├── text.py          # Text tokenization & chunking
    │   │   │   └── web_search.py    # TinyFish web search engine
    │   │   ├── models/          # Pydantic v2 schemas
    │   │   │   └── schemas.py
    │   │   ├── pipelines/       # Closed-loop AI pipelines
    │   │   │   ├── active_recall.py # 4-stage active recall study & gap audit engine
    │   │   │   ├── concepts.py      # DAG prerequisite graph builder
    │   │   │   ├── ingest.py        # Universal multi-format document ingestor
    │   │   │   ├── loop.py          # Baseline diagnostic & LangGraph state machine
    │   │   │   ├── mastery.py       # Epistemic knowledge tracing engine
    │   │   │   ├── notes.py         # Task-driven Smart Study Notes studio
    │   │   │   ├── quiz.py          # Numerical, MCQ, FITB & Q&A quiz generator
    │   │   │   ├── recommend.py     # Prerequisite-aware recommendation engine
    │   │   │   ├── tools.py         # LangGraph SVG, PPTX, PDF & resource tools
    │   │   │   ├── tts.py           # ElevenLabs Flash v2.5 deep voice synthesis
    │   │   │   └── tutor.py         # Two-layer Socratic grounded tutor
    │   │   ├── config.py        # Centralized configuration & environment loader
    │   │   ├── main.py          # FastAPI app entrypoint & static mount
    │   │   └── routes.py        # REST API endpoints & dependency injection
    │   ├── tests/               # Pytest automated test suites
    │   │   ├── openrouter_testcases.py         # 50 OpenRouter gateway tests
    │   │   ├── test_baseline_diagnostic.py     # Baseline diagnostic & zero-state tests
    │   │   ├── test_closed_loop.py             # Closed-loop lifecycle & DeepEval
    │   │   ├── test_numerical_and_active_recall.py # Numerical math & active recall tests
    │   │   ├── test_oauth_multi_tenancy.py     # Google OAuth & user isolation tests
    │   │   ├── test_openrouter_gateway.py      # Gateway failover & sanitizer tests
    │   │   ├── test_tools_tts_and_notes.py     # LangGraph tools, ElevenLabs & notes tests
    │   │   └── test_universal_material_ingest.py # Multi-format loaders tests
    │   ├── final_100_test_cases.py  # 100-test end-to-end regression battery
    │   ├── requirements.txt     # Python backend dependencies
    │   └── synonyms.json        # Normalized domain ontology configuration
    ├── frontend/                # Vanilla JS SPA (No build tools or node_modules needed)
    │   ├── css/                 # Modern styling & design system
    │   │   └── styles.css
    │   ├── js/                  # SPA application controllers
    │   │   ├── api.js           # API client with JWT bearer injection
    │   │   ├── app.js           # Routing, state machine, views & active recall loop
    │   │   └── mock.js          # Standalone offline mock data
    │   ├── vendor/              # Vendored KaTeX math rendering
    │   └── index.html           # Single-Page Application root
    └── data/                    # Persistent storage (SQLite DBs & uploads)
        ├── uploads/             # Ingested study materials
        └── vectorstore/         # Inverted index, materials & mastery SQLite DBs
```

---

## Key Features

### 1. Universal Study Material Ingestion
- Ingests `.pdf`, `.pptx`, `.md`, `.txt`, `.docx`, YouTube links (`youtube.com`, `youtu.be`), web articles (GeeksforGeeks, documentation), and voice lecture notes (`.mp3`, `.wav`, `.m4a`, `.webm`).
- Normalizes all content into an inverted SQLite/BM25 index preserving exact citations (`[Page 4]`, `[Slide 7]`, `[Timestamp 04:15]`, `[Web Section]`).
- Includes an interactive **Source Material Preview** modal supporting embedded YouTube video playback, slide decks, markdown render, and audio players.

### 2. Multi-Tenant Google OAuth 2.0 & Session Security
- Verified Google ID token sign-in with automatic student profile creation.
- Session audit logging in `user_login_logs` tracking IP address, timestamp, and user agent.
- Strict multi-tenant isolation across all SQLite tables, prerequisite DAGs, mastery records, and active recall sessions.
- Zero-state empty gating: new students start with a pristine state with zero ghost concepts.

### 3. OpenRouter Unified LLM Gateway & Auto-Failover
- Centralized completions gateway through OpenRouter (`https://openrouter.ai/api/v1/chat/completions`).
- Prioritized native fallback routing:
  1. `google/gemini-2.5-flash`
  2. `nvidia/nemotron-3-ultra-550b-a55b:free`
  3. `deepseek/deepseek-chat-v3-0324:free`
  4. `nvidia/nemotron-3.5-super-vl:free`
  5. `meta-llama/llama-3.3-70b-instruct:free`
  6. `openrouter/auto`
- Response sanitizer automatically strips `<think>...</think>` blocks and extracts clean JSON.

### 4. First-Run Baseline Diagnostic & Distinct Quiz Routing
- Gating prevents jumping into random quizzes before prior knowledge is calibrated.
- 6-question baseline test samples root and foundational DAG nodes.
- High scores ($\ge 0.80$) mark concepts as `STRONG`, failed concepts mark as `WEAK`, and downstream unassessed concepts remain `UNKNOWN`.
- Distinct quiz modes: Dashboard **"Start Review"** launches targeted remedial quizzes on top prerequisite bottlenecks, while **Concept Check** serves fresh non-repeating variants.

### 5. Numerical Step-by-Step Questions
- Support for mathematical/quantitative problems across 8 concept families: Gradient Descent updates, KNN Euclidean distance, MSE loss, Cross-Entropy, Precision/Recall, Bayes' Theorem, Learning Rate schedules, and Matrix dot products.
- Given Parameters pill grid, collapsible formula hint, numeric input, and calculation scratchpad.
- Tolerance-based grading ($\pm 0.05$) and step-by-step arithmetic derivations displayed upon submission.

### 6. 4-Stage Active Recall Engine
- **Stage 1 (Teach Phase)**: Concept selector, structured Study Card (Core Intuition, Formula/Mechanism, Worked Example, 3–5 Essential Keywords, citation pill), and timer presets (1m, 3m, 5m).
- **Stage 2 (Timed Study)**: Live SVG countdown ring with real-time progress and early *"Test Me Now"* skip.
- **Stage 3 (Blind Retrieval)**: Notes completely unmounted from DOM; open-ended retrieval textarea with word counter + 1 verification check.
- **Stage 4 (Gap Audit)**: Retrieval score donut (0–100%), green retained concept pills, red missed gap pills, memory audit against verified material, and epistemic mastery updates.

### 7. Vision-Based Medical Student ID Verification
- **AI-Powered ID Card Verification**: Students can upload a photo of their college/university ID card to verify medical/biological student status.
- **Google Gemini Vision Integration**: Uses `gemini-3.5-flash-lite` model via Google Gemini API to extract and analyze ID card details.
- **Structured JSON Extraction**: Returns `is_valid_id_card`, `student_name`, `institution`, `department_or_degree`, `is_medical_or_bio_student`, and `confidence_score`.
- **Automatic Clinical Access**: Verified medical/biological students (confidence ≥ 0.7) gain automatic access to restricted clinical study materials.
- **Privacy-First Design**: ID card images are processed in-memory via API and never stored on the server.
- **Frontend Integration**: Seamless upload modal with file validation (JPEG/PNG/WebP/GIF, max 10MB) and real-time status updates.

---

## Quick Start

### 1. Backend Setup
```bash
cd concept-mastery/backend

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate       # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment keys
cp .env.example .env
# Edit .env with your OPENROUTER_API_KEY, GOOGLE_CLIENT_ID, GEMINI_API_KEY (for ID verification), etc.

# Start FastAPI server
uvicorn app.main:app --port 8000 --reload
```

### 2. Access the Platform
- **Application UI**: Open [http://localhost:8000](http://localhost:8000)
- **API Swagger Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

---

## Running Tests (232 / 232 Passing — 100%)

The platform includes comprehensive test suites validating all core architectural dimensions:

```bash
cd concept-mastery/backend

# 1. Run all modular test suites (82 tests)
pytest tests/ -v

# 2. Run OpenRouter gateway test battery (50 tests)
pytest tests/openrouter_testcases.py -v

# 3. Run the end-to-end regression test battery (100 tests)
pytest final_100_test_cases.py -v
```

| Suite | Tests | Status |
| :--- | :---: | :---: |
| `tests/test_multi_agent_mastery.py` | 17 | **PASSED** |
| `tests/test_baseline_diagnostic.py` | 3 | **PASSED** |
| `tests/test_numerical_and_active_recall.py` | 14 | **PASSED** |
| `tests/test_oauth_multi_tenancy.py` | 7 | **PASSED** |
| `tests/test_closed_loop.py` | 7 | **PASSED** |
| `tests/test_universal_material_ingest.py` | 8 | **PASSED** |
| `tests/test_openrouter_gateway.py` | 6 | **PASSED** |
| `tests/test_tools_tts_and_notes.py` | 20 | **PASSED** |
| `tests/openrouter_testcases.py` | 50 | **PASSED** |
| `final_100_test_cases.py` | 100 | **PASSED** |
| **Total** | **232** | **100% Passed** |

---

## License
MIT License. Created as part of the Closed-Loop Concept Mastery Platform research project.
