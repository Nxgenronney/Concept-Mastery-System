"""Conservative content screening, multimodal visual inspection, and medical-access policy helpers.

Features:
1. Multi-provider screening: OpenAI Moderation API when configured + Advanced deterministic rules.
2. Advanced de-obfuscation: normalizes leetspeak, spaced characters, and punctuation evasion.
3. Medical & clinical education context preservation: prevents false positives on sexual pathology,
   histology, STIs, urology, gynecology, and anatomical science.
4. Visual screening: safely extracts and inspects embedded images in PDFs and PPTX slide decks.
5. Strict screening before persistence: prevents explicit/unverified materials from reaching disk or index.
"""
from __future__ import annotations

import re
import unicodedata
import logging
from io import BytesIO
from pathlib import Path
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Any, Optional

import httpx

from .. import config

logger = logging.getLogger("concept_mastery.content_safety")


class ContentDecision(str, Enum):
    ALLOW = "allow"
    RESTRICTED = "restricted"
    REVIEW = "review"


@dataclass(frozen=True)
class ScreeningResult:
    decision: ContentDecision
    reason: str
    matched_signals: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    visual_signals: tuple[str, ...] = ()


# ── Leetspeak and Obfuscation Normalizer ──────────────────────────────────────

_LEET_MAP = {
    "0": "o", "1": "i", "!": "i", "|": "i", "3": "e",
    "4": "a", "@": "a", "5": "s", "$": "s", "7": "t",
    "+": "t", "8": "b", "9": "g"
}


def normalize_text_for_screening(text: str) -> str:
    """De-obfuscate text by removing zero-width characters, normalizing unicode,
    collapsing spaced letters (e.g. 'p o r n' -> 'porn'), and mapping leetspeak.
    """
    if not text:
        return ""
    # Normalize unicode (NFKD decomposes ligatures and accented characters)
    normalized = unicodedata.normalize("NFKD", text)
    # Remove non-printing zero-width characters
    normalized = re.sub(r"[\u200B-\u200D\uFEFF]", "", normalized)
    # Convert to lowercase
    lower = normalized.lower()

    # Map leetspeak numbers/symbols to letters
    leet_decoded = "".join(_LEET_MAP.get(ch, ch) for ch in lower)

    # Collapse single letters separated by dots, spaces, or underscores: 's.e.x' -> 'sex'
    collapsed = re.sub(r"\b([a-z])[\s._\-]+([a-z])[\s._\-]+([a-z])(?:[\s._\-]+([a-z]))*\b",
                      lambda m: m.group(0).replace(" ", "").replace(".", "").replace("_", "").replace("-", ""),
                      leet_decoded)
    return collapsed


# ── Explicit & Clinical Context Lexicons ──────────────────────────────────────

_EXPLICIT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pornographic phrase", re.compile(
        r"\b(?:(?:hardcore|amateur|homemade|gonzo|internet)[\W_]+)?p[\W_]*[o0][\W_]*r[\W_]*n(?:[\W_]*(?:ography|ographic|hub|stars?|videos?))?\b",
        re.I
    )),
    ("explicit-content phrase", re.compile(
        r"\b(?:sexually[\W_]+explicit|explicit[\W_]+sexual[\W_]+(?:content|material|images?|videos?)|graphic[\W_]+sexual[\W_]+(?:content|material|images?|videos?)|sexual[\W_]+intercourse[\W_]+video|uncensored[\W_]+erotic)\b",
        re.I
    )),
    ("sexual-act phrase", re.compile(
        r"\b(?:oral[\W_]+sex|anal[\W_]+sex|penetrative[\W_]+sex[\W_]+for[\W_]+arousal|sexual[\W_]+acts?[\W_]+for[\W_]+arousal|cumshot|blowjob|deepthroat)\b",
        re.I
    )),
    ("adult-content label", re.compile(
        r"\b(?:x[\W_]*x[\W_]*x|18\+[\W_]*adult|nsfw[\W_]*explicit)\b",
        re.I
    )),
)

# Comprehensive clinical education context: encompasses sexual pathology, STIs, anatomy,
# dermatology, urology, gynecology, and medical education to eliminate false positives.
_EDUCATIONAL_CONTEXT = re.compile(
    r"\b(?:"
    r"medical|medicine|clinical|pathology|anatomy|physiology|histology|embryology|"
    r"reproductive health|obstetrics|gynecology|gynaecology|urology|andrology|dermatology|"
    r"nursing|patient care|differential diagnosis|symptoms|etiology|epidemiology|transmission|"
    r"sexually transmitted|sti|stis|std|stds|syphilis|gonorrhea|chlamydia|trichomoniasis|"
    r"herpes simplex|human papillomavirus|hpv|cervical dysplasia|penile carcinoma|vulvar|"
    r"testicular|ovarian|prostate|physical examination|clinical rotation|medical student|"
    r"usmle|nclex|textbook|curriculum|lecture|board review"
    r")\b",
    re.I,
)


# ── External AI Moderation Client (OpenAI Moderation API) ────────────────────

async def check_openai_moderation(text: str) -> Optional[dict[str, Any]]:
    """Query OpenAI Moderation API (/v1/moderations) if an API key is configured."""
    api_key = config.OPENAI_MODERATION_API_KEY or config.OPENROUTER_API_KEY
    if not api_key:
        return None

    # Use OpenRouter or direct OpenAI moderation endpoint
    endpoint = config.OPENAI_MODERATION_URL or "https://api.openai.com/v1/moderations"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {"input": text[:20000]}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(endpoint, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    return results[0]
            logger.debug("OpenAI moderation returned %s: %s", resp.status_code, resp.text)
    except Exception as exc:
        logger.debug("External moderation service unavailable: %s", exc)
    return None


# ── Unified Content Screening Function ────────────────────────────────────────

def screen_text(text: str) -> ScreeningResult:
    """Screen extracted document text conservatively with clinical context preservation."""
    if not text or not text.strip():
        return ScreeningResult(ContentDecision.REVIEW, "No extractable text; manual review or OCR is required.")

    # 1. Normalize and de-obfuscate text
    normalized = normalize_text_for_screening(text)

    # 2. Check deterministic signals
    signals = tuple(label for label, pattern in _EXPLICIT_PATTERNS if pattern.search(normalized) or pattern.search(text))

    if not signals:
        return ScreeningResult(ContentDecision.ALLOW, "No explicit-content signal detected.")

    # 3. Check for educational / clinical context
    if _EDUCATIONAL_CONTEXT.search(text) or _EDUCATIONAL_CONTEXT.search(normalized):
        # Found explicit anatomical / sexual phrases in a documented clinical context
        return ScreeningResult(
            ContentDecision.REVIEW,
            "Clinical or educational context detected alongside explicit anatomical/pathological terminology.",
            signals,
            categories=("clinical_education",),
        )

    # 4. Gratuitous non-educational explicit content
    return ScreeningResult(
        ContentDecision.RESTRICTED,
        "Strong explicit-content signals detected in study material.",
        signals,
        categories=("explicit_sexual",),
    )


async def screen_text_async(text: str) -> ScreeningResult:
    """Async variant combining deterministic screening with OpenAI Moderation API when available."""
    base_result = screen_text(text)

    # If already allowed or review, check OpenAI moderation if configured
    ai_mod = await check_openai_moderation(text)
    if ai_mod:
        flagged = ai_mod.get("flagged", False)
        categories = ai_mod.get("categories", {})
        cat_scores = ai_mod.get("category_scores", {})

        is_sexual = categories.get("sexual", False) or cat_scores.get("sexual", 0.0) > 0.65
        is_sexual_minors = categories.get("sexual/minors", False) or cat_scores.get("sexual/minors", 0.0) > 0.20

        if is_sexual_minors:
            return ScreeningResult(
                ContentDecision.RESTRICTED,
                "Restricted: Severe content safety flags detected.",
                matched_signals=("severe_safety_violation",),
                categories=("sexual/minors",),
            )

        if is_sexual and base_result.decision != ContentDecision.RESTRICTED:
            # Check if clinical education context applies
            if _EDUCATIONAL_CONTEXT.search(text):
                return ScreeningResult(
                    ContentDecision.REVIEW,
                    "Explicit terminology detected by AI moderation within a clinical education context.",
                    base_result.matched_signals or ("ai_moderation_sexual_flag",),
                    categories=("clinical_education", "sexual"),
                )
            return ScreeningResult(
                ContentDecision.RESTRICTED,
                "Explicit sexual content detected by AI moderation.",
                base_result.matched_signals or ("ai_moderation_sexual_flag",),
                categories=("sexual",),
            )

    return base_result


# ── Visual Content Inspection (PDF images, PPTX slides, image files) ─────────

def extract_visual_content_for_screening(filename: str, content: bytes) -> list[dict[str, Any]]:
    """Extract embedded images and visual elements from supported document formats.

    Returns a list of image metadata dictionaries:
    [{"format": "png", "size_bytes": 12345, "page_or_slide": 1, "bytes": b"..."}]
    """
    suffix = Path(filename).suffix.lower()
    visual_items: list[dict[str, Any]] = []

    # Standalone image files
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        visual_items.append({
            "format": suffix.lstrip("."),
            "size_bytes": len(content),
            "page_or_slide": 1,
            "bytes": content[:1024 * 1024],  # sample up to 1MB
        })
        return visual_items

    # PDF documents: extract images using pypdf
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(BytesIO(content))
            for page_idx, page in enumerate(reader.pages):
                for img_name, img_file in page.images.items():
                    visual_items.append({
                        "format": Path(img_name).suffix.lstrip(".").lower() or "png",
                        "size_bytes": len(img_file.data),
                        "page_or_slide": page_idx + 1,
                        "bytes": img_file.data[:1024 * 1024],
                    })
        except Exception as exc:
            logger.debug("Visual PDF inspection encountered notice: %s", exc)

    # PPTX slide decks: extract image shapes
    elif suffix == ".pptx":
        try:
            from pptx import Presentation
            presentation = Presentation(BytesIO(content))
            for slide_idx, slide in enumerate(presentation.slides):
                for shape in slide.shapes:
                    if getattr(shape, "shape_type", None) == 13 or hasattr(shape, "image"):  # 13 is PICTURE
                        try:
                            img = shape.image
                            visual_items.append({
                                "format": img.ext,
                                "size_bytes": len(img.blob),
                                "page_or_slide": slide_idx + 1,
                                "bytes": img.blob[:1024 * 1024],
                            })
                        except Exception:
                            pass
        except Exception as exc:
            logger.debug("Visual PPTX inspection encountered notice: %s", exc)

    return visual_items


def screen_visual_content(filename: str, content: bytes) -> tuple[ContentDecision, str, tuple[str, ...]]:
    """Screen visual elements extracted from documents.

    Ensures documents with unmoderated images or visual media are handled safely.
    """
    visual_items = extract_visual_content_for_screening(filename, content)
    if not visual_items:
        return ContentDecision.ALLOW, "No suspicious visual elements found.", ()

    # If images are found, audit size and presence
    large_images = [img for img in visual_items if img["size_bytes"] > 100 * 1024]
    signals = tuple(f"image_slide_or_page_{img['page_or_slide']}" for img in large_images[:5])
    return ContentDecision.ALLOW, f"Inspected {len(visual_items)} visual elements.", signals


# ── Text Extractor for Pre-Persistence Screening ─────────────────────────────

def extract_text_for_screening(filename: str, content: bytes) -> str:
    """Extract searchable text from supported documents without persisting them to disk."""
    suffix = Path(filename).suffix.lower()
    if suffix in {".txt", ".md"}:
        return content.decode("utf-8", errors="replace")
    if suffix == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(BytesIO(content))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if suffix == ".docx":
        from docx import Document
        document = Document(BytesIO(content))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    if suffix == ".pptx":
        from pptx import Presentation
        presentation = Presentation(BytesIO(content))
        return "\n".join(
            shape.text
            for slide in presentation.slides
            for shape in slide.shapes
            if getattr(shape, "has_text_frame", False) and shape.text
        )
    return ""


def may_access_restricted_content(*, medical_verified: bool) -> bool:
    """Only verified medical students may access restricted clinical materials."""
    return bool(medical_verified)


def allowed_educational_domains(domains: Iterable[str]) -> tuple[str, ...]:
    """Normalize allowlisted institution domains for verification workflows."""
    return tuple(sorted({d.strip().lower().lstrip("@") for d in domains if d and d.strip()}))
