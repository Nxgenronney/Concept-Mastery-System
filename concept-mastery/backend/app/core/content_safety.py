"""Conservative content screening and medical-access policy helpers.

This module intentionally separates explicit-content detection from access
authorization. A text-only heuristic is a screening signal, not a definitive
classifier; production deployments should add image/video moderation and
human review for borderline material.
"""
from __future__ import annotations

import re
from io import BytesIO
from pathlib import Path
from dataclasses import dataclass
from enum import Enum
from typing import Iterable


class ContentDecision(str, Enum):
    ALLOW = "allow"
    RESTRICTED = "restricted"
    REVIEW = "review"


@dataclass(frozen=True)
class ScreeningResult:
    decision: ContentDecision
    reason: str
    matched_signals: tuple[str, ...] = ()


# Strong phrase signals only. Do not flag isolated clinical terms such as
# "breast", "penis", "vagina", "reproduction", "anatomy", or "sexual health".
_EXPLICIT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Permit punctuation/spacing and common digit substitutions between letters
    # so simple obfuscations (p.o.r.n, p0rn) do not bypass the text screen.
    ("pornographic phrase", re.compile(r"\b(?:(?:hardcore|amateur|homemade)[\W_]+)?p[\W_]*[o0][\W_]*r[\W_]*n(?:[\W_]*(?:ography|ographic))?\b", re.I)),
    ("explicit-content phrase", re.compile(r"\b(?:sexually[\W_]+explicit|explicit[\W_]+sexual[\W_]+(?:content|material|images?|videos?)|graphic[\W_]+sexual[\W_]+(?:content|material|images?|videos?)|sexual[\W_]+intercourse[\W_]+video)\b", re.I)),
    ("sexual-act phrase", re.compile(r"\b(?:oral[\W_]+sex|anal[\W_]+sex|sexual[\W_]+acts?[\W_]+for[\W_]+arousal)\b", re.I)),
    ("adult-content label", re.compile(r"\b(?:x[\W_]*x[\W_]*x|18\+[\W_]*adult)\b", re.I)),
)
_EDUCATIONAL_CONTEXT = re.compile(
    r"\b(?:medical|medicine|anatomy|physiology|histology|clinical|"
    r"reproductive health|obstetrics|gynecology|gynaecology|urology|"
    r"nursing|pathology|medical education|textbook|lecture|patient care)\b",
    re.I,
)


def screen_text(text: str) -> ScreeningResult:
    """Screen extracted text conservatively, exempting clear educational context."""
    if not text or not text.strip():
        return ScreeningResult(ContentDecision.REVIEW, "No extractable text; manual review is required.")
    signals = tuple(label for label, pattern in _EXPLICIT_PATTERNS if pattern.search(text))
    if not signals:
        return ScreeningResult(ContentDecision.ALLOW, "No strong explicit-content signal detected.")
    if _EDUCATIONAL_CONTEXT.search(text):
        return ScreeningResult(
            ContentDecision.REVIEW,
            "Explicit terms occur in an educational/clinical context; request a human review.",
            signals,
        )
    return ScreeningResult(
        ContentDecision.RESTRICTED,
        "Strong explicit-content signals detected in study material.",
        signals,
    )


def may_access_restricted_content(*, medical_verified: bool) -> bool:
    """Only verified medical students may access restricted explicit materials."""
    return bool(medical_verified)


def allowed_educational_domains(domains: Iterable[str]) -> tuple[str, ...]:
    """Normalize allowlisted institution domains for verification workflows."""
    return tuple(sorted({d.strip().lower().lstrip("@") for d in domains if d and d.strip()}))



def extract_text_for_screening(filename: str, content: bytes) -> str:
    """Extract searchable text from supported documents without persisting them.

    Empty text is treated as unscannable by screen_text, not as safe.
    Image-only PDFs and audio/video require OCR or modality-specific review.
    """
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
    # Unsupported modalities fail closed until OCR/audio/video moderation exists.
    return ""
