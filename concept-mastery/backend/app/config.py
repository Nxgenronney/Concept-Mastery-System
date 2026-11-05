import os
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]          # backend/
try:
    from dotenv import load_dotenv
    load_dotenv(BASE / ".env")
except ImportError:
    pass

def _e(k, d=""):
    return os.getenv(k, d).split("#")[0].strip()


def _p(key, default):
    return (BASE / os.getenv(key, default).split("#")[0].strip()).resolve()


UPLOAD_DIR = _p("UPLOAD_DIR", "../data/uploads")
VECTOR_STORE_PATH = _p("VECTOR_STORE_PATH", "../data/vectorstore")
MEDICAL_VERIFICATION_DIR = VECTOR_STORE_PATH / "medical_verification"
MEDICAL_VERIFICATION_REVIEW_TOKEN = _e("MEDICAL_VERIFICATION_REVIEW_TOKEN", "")
FRONTEND_DIR = (BASE.parent / "frontend").resolve()
SYNONYMS_FILE = BASE / "synonyms.json"

# PageIndex API
PAGEINDEX_API_KEY = _e("PAGEINDEX_API_KEY", "")

# Google OAuth 2.0 & Session Security
GOOGLE_CLIENT_ID = _e("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = _e("GOOGLE_CLIENT_SECRET", "")
JWT_SECRET = _e("JWT_SECRET", "concept-mastery-jwt-secret-key-32bytes")
JWT_ALGORITHM = _e("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(_e("JWT_EXPIRES_MINUTES", "10080"))  # 7 days
ENVIRONMENT = _e("ENVIRONMENT", "development")

# Unified OpenRouter Gateway & Fallback Models
OPENROUTER_API_KEY = _e("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = _e("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_MODELS = [
    "google/gemini-2.5-flash",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek/deepseek-chat-v3-0324:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/auto",
]
OPENROUTER_PRIMARY_MODEL = _e("OPENROUTER_MODEL", "google/gemini-2.5-flash")

# Primary Provider: Google Gemini (Legacy/Direct)
GEMINI_API_KEY = _e("GEMINI_API_KEY", "")
GEMINI_MODEL = _e("GEMINI_MODEL", "gemini-3.8-flash")

# Fallback Provider: Groq Cloud
GROQ_API_KEY = _e("GROQ_API_KEY", "")
GROQ_MODEL = _e("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_BASE_URL = _e("GROQ_BASE_URL", "https://api.groq.com/openai/v1")

# TinyFish Web Search API
TINYFISH_API_KEY = _e("TINYFISH_API_KEY", "")
TINYFISH_SEARCH_URL = _e("TINYFISH_SEARCH_URL", "https://api.search.tinyfish.ai")

# ElevenLabs Flash v2.5 TTS
ELEVENLABS_API_KEY = _e("ELEVENLABS_API_KEY", "")
ELEVENLABS_MODEL_ID = _e("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")
ELEVENLABS_VOICE_ID = _e("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
GENERATED_ARTIFACTS_DIR = (BASE / "generated_artifacts").resolve()
GENERATED_ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

# Legacy / Generic Provider
LLM_PROVIDER, LLM_API_KEY, LLM_MODEL = _e("LLM_PROVIDER", "openai").lower(), _e("LLM_API_KEY"), _e("LLM_MODEL")
LLM_BASE_URL = _e("LLM_BASE_URL", "https://api.openai.com/v1")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
VECTOR_STORE_PATH.mkdir(parents=True, exist_ok=True)
MEDICAL_VERIFICATION_DIR.mkdir(parents=True, exist_ok=True)
try:
    MEDICAL_VERIFICATION_DIR.chmod(0o700)
except OSError:
    pass
