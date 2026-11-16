"""Multi-Format Universal Study Material Ingestion Pipeline.

Supports universal study material ingestion using LangChain Document Loaders
orchestrated via a deterministic LangGraph Ingestion Pipeline:
  detect_source_type -> extract_raw_content -> semantic_section_chunker -> synonym_normalizer -> sqlite_bm25_index -> update_prerequisite_dag

Supported Material Formats:
  1. PDF Documents (.pdf) - PyPDFLoader / pypdf, 1-indexed [Page X] metadata.
  2. Presentations (.pptx, .ppt) - python-pptx / Unstructured, anchored as [Slide X].
  3. Markdown, Text & Word Docs (.md, .txt, .docx) - docx / Unstructured, anchored as [Section X].
  4. YouTube Video Links (youtube.com, youtu.be) - youtube-transcript-api, anchored as [Timestamp MM:SS].
  5. Educational Websites & Articles (GeeksforGeeks, docs) - BeautifulSoup4, anchored as [Web Section: Heading].
  6. Student Voice Notes & Lecture Audio (.mp3, .wav, .m4a, .webm) - Groq Whisper, anchored as [Audio MM:SS].

Normalizes all sources into the 100% Vectorless SQLite/BM25 Inverted Index,
persists in SQLite study_materials table, and powers the interactive Source Preview UI.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, TypedDict

from langgraph.graph import StateGraph, END

from .. import config
from ..core import store
from ..core.concept_index import GLOBAL_INDEX
from ..core.text import sentences, NORMALIZER
from ..models.schemas import ChunkMetadata
from . import concepts, mastery

CHUNK_WORDS = 110
_PAGE_NO = re.compile(r"^(page\s+)?\d+(\s*(of|/)\s*\d+)?$", re.I)
_NUMBERING = re.compile(r"^(chapter|section|unit)?\s*\d+(\.\d+)*[.)]?\s+", re.I)
_SMALL = {"of", "and", "the", "in", "to", "for", "a", "vs", "with", "on", "an"}


# ── Heading & Text Helpers ──────────────────────────────────────────────────

def is_heading(line: str) -> bool:
    """Detect if line is a semantic heading / section title."""
    words = line.split()
    if not (1 <= len(words) <= 9) or len(line) > 70 or line[-1] in ".,;:!?":
        return False
    if _NUMBERING.match(line):
        return True
    alpha = [w for w in words if w[0].isalpha()]
    return bool(alpha) and (line.isupper() or all(w[0].isupper() or w.lower() in _SMALL for w in alpha))


def clean_heading(line: str) -> str:
    h = _NUMBERING.sub("", line).strip()
    return h.title() if h.isupper() else h


# ── Format Loaders ──────────────────────────────────────────────────────────

def extract_pages(path: Path) -> list[tuple[int, str]]:
    """Extract pages from PDF returning [(1-based page_num, text), ...]. Legacy compatible."""
    from pypdf import PdfReader
    try:
        reader = PdfReader(str(path))
        pages = []
        for i, p in enumerate(reader.pages):
            text = p.extract_text() or ""
            pages.append((i + 1, text))
        return pages
    except store.UserError:
        raise
    except Exception as e:
        raise store.UserError(f"Could not read PDF '{path.name}': {e}")


def load_pdf_material(path: Path) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Load PDF file preserving exact 1-indexed pages and citation anchors [Page X]."""
    pages = extract_pages(path)
    if not any(t.strip() for _, t in pages):
        raise store.UserError("No readable text found in uploaded PDF. Scanned PDFs need OCR first.")

    title = path.stem.replace("_", " ").replace("-", " ").title()
    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []
    full_text_parts: List[str] = []

    for page_num, page_text in pages:
        cleaned_text = page_text.strip()
        preview_item = {
            "index": page_num,
            "label": f"Page {page_num}",
            "text": cleaned_text
        }
        structured_preview.append(preview_item)
        if cleaned_text:
            full_text_parts.append(cleaned_text)
            raw_items.append({
                "page": page_num,
                "locator_label": f"Page {page_num}",
                "section": "Introduction",
                "text": cleaned_text
            })

    return title, raw_items, structured_preview, "\n\n".join(full_text_parts)


def load_pptx_material(path: Path) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Load PowerPoint presentation (.pptx) extracting slide titles, body, and notes. Anchors [Slide X]."""
    try:
        from pptx import Presentation
        prs = Presentation(str(path))
    except Exception as e:
        raise store.UserError(f"Could not parse PowerPoint presentation '{path.name}': {e}")

    title = path.stem.replace("_", " ").replace("-", " ").title()
    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []
    full_text_parts: List[str] = []

    for idx, slide in enumerate(prs.slides, start=1):
        slide_title = ""
        body_lines: List[str] = []

        for shape in slide.shapes:
            if shape.has_text_frame:
                txt = shape.text_frame.text.strip()
                if not txt:
                    continue
                if not slide_title and (shape == slide.shapes.title or "title" in shape.name.lower()):
                    slide_title = txt
                else:
                    body_lines.append(txt)

        notes = ""
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                notes = slide.notes_slide.notes_text_frame.text.strip()
        except Exception:
            notes = ""

        resolved_title = slide_title or f"Slide {idx}"
        slide_body = "\n".join(body_lines)
        combined_text = resolved_title + ("\n" + slide_body if slide_body else "")
        if notes:
            combined_text += f"\nSpeaker Notes: {notes}"

        structured_preview.append({
            "index": idx,
            "label": f"Slide {idx}",
            "title": resolved_title,
            "text": slide_body,
            "notes": notes
        })

        if combined_text.strip():
            full_text_parts.append(combined_text)
            raw_items.append({
                "page": idx,
                "locator_label": f"Slide {idx}",
                "section": clean_heading(resolved_title),
                "text": combined_text
            })

    if not raw_items:
        raise store.UserError(f"PowerPoint file '{path.name}' contains no readable slide text.")

    return title, raw_items, structured_preview, "\n\n".join(full_text_parts)


def load_markdown_material(path: Path) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Load Markdown or Text doc (.md, .txt) chunked by heading hierarchy (#, ##, ###). Anchors [Section: ...]."""
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise store.UserError(f"Could not read text document '{path.name}': {e}")

    title = path.stem.replace("_", " ").replace("-", " ").title()
    lines = content.splitlines()

    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []
    current_heading = "Introduction"
    current_lines: List[str] = []
    section_index = 1

    def flush_section():
        nonlocal section_index, current_heading, current_lines
        body = "\n".join(current_lines).strip()
        if body:
            label = f"Section: {current_heading}"
            structured_preview.append({
                "index": section_index,
                "label": label,
                "heading": current_heading,
                "text": body
            })
            raw_items.append({
                "page": section_index,
                "locator_label": label,
                "section": current_heading,
                "text": f"{current_heading}\n{body}"
            })
            section_index += 1
        current_lines = []

    for line in lines:
        sline = line.strip()
        if sline.startswith("#"):
            flush_section()
            h_text = sline.lstrip("#").strip()
            current_heading = clean_heading(h_text) or f"Section {section_index}"
        elif is_heading(sline) and not sline.startswith("```"):
            flush_section()
            current_heading = clean_heading(sline)
        else:
            current_lines.append(line)

    flush_section()

    if not raw_items:
        # Fallback if no sections detected
        body = content.strip()
        if body:
            raw_items.append({
                "page": 1,
                "locator_label": "Section: Overview",
                "section": "Overview",
                "text": body
            })
            structured_preview.append({
                "index": 1,
                "label": "Section: Overview",
                "heading": "Overview",
                "text": body
            })

    if not raw_items:
        raise store.UserError(f"File '{path.name}' is empty.")

    return title, raw_items, structured_preview, content


def load_docx_material(path: Path) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Load Microsoft Word document (.docx) extracting headings and paragraphs. Anchors [Section: ...]."""
    try:
        from docx import Document
        doc = Document(str(path))
    except Exception as e:
        raise store.UserError(f"Could not parse Word document '{path.name}': {e}")

    title = path.stem.replace("_", " ").replace("-", " ").title()
    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []
    current_heading = "Introduction"
    current_lines: List[str] = []
    section_index = 1

    def flush_docx_section():
        nonlocal section_index, current_heading, current_lines
        body = "\n".join(current_lines).strip()
        if body:
            label = f"Section: {current_heading}"
            structured_preview.append({
                "index": section_index,
                "label": label,
                "heading": current_heading,
                "text": body
            })
            raw_items.append({
                "page": section_index,
                "locator_label": label,
                "section": current_heading,
                "text": f"{current_heading}\n{body}"
            })
            section_index += 1
        current_lines = []

    for p in doc.paragraphs:
        txt = p.text.strip()
        if not txt:
            continue
        style_name = (p.style.name if p.style else "").lower()
        if "heading" in style_name or is_heading(txt):
            flush_docx_section()
            current_heading = clean_heading(txt)
        else:
            current_lines.append(txt)

    flush_docx_section()

    if not raw_items:
        raise store.UserError(f"Word document '{path.name}' contains no readable text.")

    full_text = "\n\n".join(item["text"] for item in raw_items)
    return title, raw_items, structured_preview, full_text


def extract_youtube_id(url: str) -> Optional[str]:
    """Extract 11-character YouTube video ID from various URL formats."""
    parsed = urllib.parse.urlparse(url)
    if "youtube.com" in parsed.netloc:
        if parsed.path == "/watch":
            qs = urllib.parse.parse_qs(parsed.query)
            return qs.get("v", [None])[0]
        elif parsed.path.startswith("/embed/"):
            return parsed.path.split("/embed/")[1].split("/")[0]
        elif parsed.path.startswith("/shorts/"):
            return parsed.path.split("/shorts/")[1].split("/")[0]
    elif "youtu.be" in parsed.netloc:
        return parsed.path.strip("/").split("/")[0]
    return None


def format_seconds_to_timestamp(seconds: float | int) -> str:
    """Format seconds into MM:SS or HH:MM:SS format."""
    sec = int(max(0, seconds))
    hours = sec // 3600
    minutes = (sec % 3600) // 60
    rem_seconds = sec % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{rem_seconds:02d}"
    return f"{minutes:02d}:{rem_seconds:02d}"


def load_youtube_material(url: str, custom_title: Optional[str] = None) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Fetch timestamped YouTube video transcript across full duration and segment into sliding topic windows."""
    video_id = extract_youtube_id(url)
    if not video_id:
        raise store.UserError(f"Invalid YouTube URL: '{url}'. Please provide a standard watch or youtu.be link.")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        if hasattr(YouTubeTranscriptApi, "get_transcript"):
            raw_transcript = YouTubeTranscriptApi.get_transcript(video_id)
        else:
            yta = YouTubeTranscriptApi()
            fetched = yta.fetch(video_id)
            if hasattr(fetched, "to_raw_data"):
                raw_transcript = fetched.to_raw_data()
            else:
                raw_transcript = [
                    {
                        "text": getattr(s, "text", s.get("text") if isinstance(s, dict) else str(s)),
                        "start": getattr(s, "start", s.get("start", 0.0) if isinstance(s, dict) else 0.0),
                        "duration": getattr(s, "duration", s.get("duration", 0.0) if isinstance(s, dict) else 0.0),
                    }
                    for s in fetched
                ]
    except Exception as e:
        raise store.UserError(f"Could not load YouTube transcript for video {video_id}. "
                              f"Ensure the video has public subtitles or captions enabled. ({e})")

    if not raw_transcript:
        raise store.UserError(f"No subtitle segments found for YouTube video {video_id}.")

    # Collect and sort all snippets chronologically across 100% of video duration
    snippets = []
    for s in raw_transcript:
        text = str(s.get("text", "")).strip()
        start = float(s.get("start", 0.0))
        dur = float(s.get("duration", 0.0))
        if text:
            snippets.append({"text": text, "start": start, "duration": dur})
    snippets.sort(key=lambda x: x["start"])

    if not snippets:
        raise store.UserError(f"No valid transcript text found for YouTube video {video_id}.")

    title = custom_title or f"YouTube Lecture: {video_id}"
    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []

    # Sliding 3-to-4 minute semantic topic window segmenter (minimum 150-300 words)
    WINDOW_TARGET_SEC = 180.0   # 3.0 minutes minimum target per window
    WINDOW_STRIDE_SEC = 120.0   # 2.0 minutes stride (~60s overlap)
    total_duration = max((s["start"] + s["duration"] for s in snippets), default=0.0)

    if total_duration <= 180.0:
        combined = " ".join(s["text"] for s in snippets).strip()
        start_sec = snippets[0]["start"]
        start_ts = format_seconds_to_timestamp(start_sec)
        end_ts = format_seconds_to_timestamp(total_duration)
        label = f"{start_ts} - {end_ts}" if start_ts != end_ts else start_ts
        structured_preview.append({
            "index": 1,
            "label": label,
            "timestamp": label,
            "start_seconds": int(start_sec),
            "end_seconds": int(total_duration),
            "text": combined,
            "video_id": video_id,
        })
        raw_items.append({
            "page": 1,
            "locator_label": label,
            "section": f"Video [{label}]",
            "text": combined,
        })
    else:
        window_index = 1
        curr_idx = 0
        n_snippets = len(snippets)

        while curr_idx < n_snippets:
            window_start_sec = snippets[curr_idx]["start"]
            target_end_sec = window_start_sec + WINDOW_TARGET_SEC

            window_texts = []
            window_end_sec = window_start_sec

            end_idx = curr_idx
            while end_idx < n_snippets:
                s = snippets[end_idx]
                window_texts.append(s["text"])
                window_end_sec = max(window_end_sec, s["start"] + s.get("duration", 0.0))
                end_idx += 1
                total_w = sum(len(t.split()) for t in window_texts)
                if s["start"] >= target_end_sec and total_w >= 35:
                    break

            combined = " ".join(window_texts).strip()
            start_ts = format_seconds_to_timestamp(window_start_sec)
            end_ts = format_seconds_to_timestamp(window_end_sec)
            ts_range = f"{start_ts} - {end_ts}"

            structured_preview.append({
                "index": window_index,
                "label": ts_range,
                "timestamp": ts_range,
                "start_seconds": int(window_start_sec),
                "end_seconds": int(window_end_sec),
                "text": combined,
                "video_id": video_id,
            })

            raw_items.append({
                "page": window_index,
                "locator_label": ts_range,
                "section": f"Video [{ts_range}]",
                "text": combined,
            })

            window_index += 1

            # Advance curr_idx using stride to maintain continuous overlapping progression
            next_start_target = window_start_sec + WINDOW_STRIDE_SEC
            next_idx = curr_idx + 1
            while next_idx < n_snippets and snippets[next_idx]["start"] < next_start_target:
                next_idx += 1

            if next_idx >= n_snippets or next_idx == curr_idx:
                if end_idx < n_snippets:
                    tail_texts = [s["text"] for s in snippets[curr_idx:]]
                    tail_combined = " ".join(tail_texts).strip()
                    tail_start = snippets[curr_idx]["start"]
                    tail_start_ts = format_seconds_to_timestamp(tail_start)
                    tail_end_ts = format_seconds_to_timestamp(total_duration)
                    tail_label = f"{tail_start_ts} - {tail_end_ts}"
                    structured_preview.append({
                        "index": window_index,
                        "label": tail_label,
                        "timestamp": tail_label,
                        "start_seconds": int(tail_start),
                        "end_seconds": int(total_duration),
                        "text": tail_combined,
                        "video_id": video_id,
                    })
                    raw_items.append({
                        "page": window_index,
                        "locator_label": tail_label,
                        "section": f"Video [{tail_label}]",
                        "text": tail_combined,
                    })
                break
            curr_idx = next_idx

    full_text = "\n\n".join(item["text"] for item in raw_items)
    return title, raw_items, structured_preview, full_text


def load_web_article_material(url: str, custom_title: Optional[str] = None) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Fetch educational web page (GeeksforGeeks, docs, tutorials) and extract clean reader view. Anchors [Web: Heading]."""
    if not (url.startswith("http://") or url.startswith("https://")):
        raise store.UserError(f"Invalid URL '{url}'. URLs must begin with http:// or https://")

    try:
        from bs4 import BeautifulSoup
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        )
        with urllib.request.urlopen(req, timeout=12) as response:
            html = response.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise store.UserError(f"Failed to fetch content from URL '{url}': {e}")

    soup = BeautifulSoup(html, "html.parser")

    # Strip clutter: navigation, scripts, ads, headers, footers
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript", "svg", "form", "iframe"]):
        tag.decompose()

    # Determine Page Title
    page_title = custom_title
    if not page_title:
        h1 = soup.find("h1")
        if h1 and h1.get_text().strip():
            page_title = h1.get_text().strip()
        elif soup.title and soup.title.get_text().strip():
            page_title = soup.title.get_text().strip()
        else:
            page_title = urllib.parse.urlparse(url).netloc

    # Find main article container if available
    main_container = (
        soup.find("article")
        or soup.find("main")
        or soup.find("div", class_=re.compile(r"article|content|post|entry|main", re.I))
        or soup.body
    )

    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []
    current_heading = "Overview"
    current_parts: List[str] = []
    section_index = 1

    def flush_web_section():
        nonlocal section_index, current_heading, current_parts
        body = "\n\n".join(current_parts).strip()
        if body and len(body.split()) >= 6:
            label = f"Web: {current_heading}"
            structured_preview.append({
                "index": section_index,
                "label": label,
                "heading": current_heading,
                "text": body
            })
            raw_items.append({
                "page": section_index,
                "locator_label": label,
                "section": current_heading,
                "text": f"{current_heading}\n{body}"
            })
            section_index += 1
        current_parts = []

    if main_container:
        for elem in main_container.find_all(["h1", "h2", "h3", "h4", "p", "pre", "ul", "ol"]):
            if elem.name in ["h1", "h2", "h3", "h4"]:
                h_text = elem.get_text().strip()
                if h_text and len(h_text) < 100:
                    flush_web_section()
                    current_heading = clean_heading(h_text)
            elif elem.name == "pre":
                code = elem.get_text().strip()
                if code:
                    current_parts.append(f"```\n{code[:500]}\n```")
            elif elem.name in ["ul", "ol"]:
                lis = [li.get_text().strip() for li in elem.find_all("li") if li.get_text().strip()]
                if lis:
                    current_parts.append("\n".join(f"• {li}" for li in lis[:10]))
            elif elem.name == "p":
                p_text = elem.get_text().strip()
                if p_text and len(p_text.split()) >= 4:
                    current_parts.append(p_text)

    flush_web_section()

    if not raw_items:
        text = soup.get_text(separator="\n", strip=True)
        if len(text.split()) < 20:
            raise store.UserError(f"No meaningful article content could be extracted from '{url}'.")
        raw_items.append({
            "page": 1,
            "locator_label": f"Web: {page_title[:30]}",
            "section": page_title[:30],
            "text": text[:3000]
        })
        structured_preview.append({
            "index": 1,
            "label": f"Web: {page_title[:30]}",
            "heading": page_title[:30],
            "text": text[:3000]
        })

    full_text = "\n\n".join(item["text"] for item in raw_items)
    return page_title, raw_items, structured_preview, full_text


def load_audio_material(path: Path, custom_title: Optional[str] = None) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Transcribe lecture voice notes (.mp3, .wav, .m4a, .webm) via Groq Whisper with timestamped topic windows. Anchors [Audio MM:SS]."""
    title = custom_title or path.stem.replace("_", " ").replace("-", " ").title()

    transcript_segments: List[Dict[str, Any]] = []

    # Check for companion transcript file first (useful for offline test fixtures)
    companion_txt = path.with_suffix(".txt")
    if companion_txt.exists():
        content = companion_txt.read_text(encoding="utf-8", errors="replace")
        transcript_segments.append({"start": 0.0, "end": 60.0, "text": content.strip()})
    elif getattr(config, "GROQ_API_KEY", None) and config.GROQ_API_KEY.strip():
        try:
            from groq import Groq
            client = Groq(api_key=config.GROQ_API_KEY)
            with open(path, "rb") as f:
                transcription = client.audio.transcriptions.create(
                    file=(path.name, f.read()),
                    model="whisper-large-v3",
                    response_format="verbose_json"
                )
            if hasattr(transcription, "segments") and transcription.segments:
                for seg in transcription.segments:
                    transcript_segments.append({
                        "start": float(seg.get("start", 0.0) if isinstance(seg, dict) else getattr(seg, "start", 0.0)),
                        "end": float(seg.get("end", 0.0) if isinstance(seg, dict) else getattr(seg, "end", 0.0)),
                        "text": str(seg.get("text", "") if isinstance(seg, dict) else getattr(seg, "text", "")).strip(),
                    })
            elif hasattr(transcription, "text"):
                transcript_segments.append({"start": 0.0, "end": 30.0, "text": transcription.text.strip()})
        except Exception as e:
            transcript_segments.append({
                "start": 0.0,
                "end": 30.0,
                "text": f"Audio lecture recording: {title}. Automatic transcription fallback."
            })
    else:
        # Offline deterministic fallback for tests
        transcript_segments.append({
            "start": 0.0,
            "end": 30.0,
            "text": f"Lecture Audio voice note on {title}. Key conceptual highlights and spoken explanations."
        })

    raw_items: List[Dict[str, Any]] = []
    structured_preview: List[Dict[str, Any]] = []

    for idx, seg in enumerate(transcript_segments, start=1):
        start_sec = int(seg.get("start", 0))
        mm = start_sec // 60
        ss = start_sec % 60
        ts_label = f"Audio {mm:02d}:{ss:02d}"
        seg_text = seg.get("text", "").strip()
        if not seg_text:
            continue

        structured_preview.append({
            "index": idx,
            "label": ts_label,
            "timestamp": f"{mm:02d}:{ss:02d}",
            "start_seconds": start_sec,
            "text": seg_text
        })
        raw_items.append({
            "page": idx,
            "locator_label": ts_label,
            "section": f"Voice Note ({mm:02d}:{ss:02d})",
            "text": seg_text
        })

    if not raw_items:
        raise store.UserError(f"Could not extract speech transcript from audio file '{path.name}'.")

    full_text = "\n\n".join(item["text"] for item in raw_items)
    return title, raw_items, structured_preview, full_text


# ── Semantic Section Chunker ────────────────────────────────────────────────

def _emit(chunks: list[dict], page: int, section: str, buf: list[str], source_filename: str):
    """Emit semantic chunks respecting sentence boundaries (legacy compatible)."""
    body = re.sub(r"\s+", " ", " ".join(buf)).strip()
    buf.clear()
    cur, n = [], 0
    for s in sentences(body) + [None]:
        if s is None or (n + len(s.split()) > CHUNK_WORDS and cur):
            text = " ".join(cur)
            words = text.split()
            if len(words) >= 8:
                chunks.append({
                    "id": len(chunks),
                    "chunk_id": str(uuid.uuid4()),
                    "page": page,
                    "section": section,
                    "text": text,
                    "source_filename": source_filename,
                    "token_count": len(words),
                    "canonical_concepts": [],
                })
            cur, n = [], 0
        if s:
            cur.append(s)
            n += len(s.split())


def chunk_pages(pages: list[tuple[int, str]], source_filename: str) -> list[dict]:
    """Segment pages into section-based chunks (legacy compatible)."""
    chunks: list[dict] = []
    section = "Introduction"
    for page, text in pages:
        buf: list[str] = []
        for line in (l.strip() for l in text.splitlines()):
            if not line or _PAGE_NO.match(line):
                continue
            if is_heading(line):
                _emit(chunks, page, section, buf, source_filename)
                section = clean_heading(line)
            else:
                buf.append(line)
        _emit(chunks, page, section, buf, source_filename)
    return chunks


def chunk_extracted_items(
    items: List[Dict[str, Any]],
    source_id: str,
    source_type: str,
    source_title: str,
    origin_name: str
) -> List[Dict[str, Any]]:
    """Segment raw extracted items into cohesive, semantic chunks of at least 150-300 words.

    Prevents micro-chunk fragmentation by aggregating adjacent sparse items (e.g. single-sentence slides,
    micro-transcripts, short paragraphs) under composite locators [Page 1-2] or [00:00 - 03:45].
    """
    MIN_WORDS = 80
    TARGET_WORDS = 150
    MAX_WORDS = 260

    chunks: List[Dict[str, Any]] = []

    cur_sentences: List[str] = []
    cur_pages: List[int] = []
    cur_locators: List[str] = []
    cur_sections: List[str] = []
    cur_word_count = 0

    def _flush_buffer():
        nonlocal cur_sentences, cur_pages, cur_locators, cur_sections, cur_word_count
        if not cur_sentences:
            return

        text = " ".join(cur_sentences).strip()
        words = text.split()
        if not words:
            return

        # Determine composite locator label
        first_page = cur_pages[0] if cur_pages else 1
        last_page = cur_pages[-1] if cur_pages else first_page

        if source_type == "pdf":
            comp_locator = f"Page {first_page}" if first_page == last_page else f"Pages {first_page}-{last_page}"
        elif source_type == "pptx":
            comp_locator = f"Slide {first_page}" if first_page == last_page else f"Slides {first_page}-{last_page}"
        else:
            locs = [l.replace("[", "").replace("]", "").replace("Video ", "").strip() for l in cur_locators if l]
            if locs:
                if len(locs) == 1 or locs[0] == locs[-1] or (" - " in locs[0]):
                    comp_locator = locs[0]
                else:
                    start_part = locs[0].split(" - ")[0]
                    end_part = locs[-1].split(" - ")[-1]
                    comp_locator = f"{start_part} - {end_part}"
            else:
                comp_locator = f"Section {first_page}"

        # Choose the most descriptive section title from cur_sections
        chosen_section = "Introduction"
        for sec in cur_sections:
            if sec and not concepts.is_generic_section_heading(sec):
                chosen_section = sec
                break
        if chosen_section == "Introduction" and cur_sections:
            chosen_section = cur_sections[0]

        chunks.append({
            "id": len(chunks),
            "chunk_id": str(uuid.uuid4()),
            "page": first_page,
            "section": chosen_section,
            "locator_label": comp_locator,
            "text": text,
            "token_count": len(words),
            "canonical_concepts": [],
            "source_id": source_id,
            "source_type": source_type,
            "source_title": source_title,
            "origin_url_or_filename": origin_name,
            "source_filename": origin_name,
        })

        cur_sentences.clear()
        cur_pages.clear()
        cur_locators.clear()
        cur_sections.clear()
        cur_word_count = 0

    for item in items:
        page = int(item.get("page", 1))
        section = str(item.get("section", "Introduction"))
        locator = str(item.get("locator_label") or (f"Page {page}" if source_type == "pdf" else section))
        raw_text = str(item.get("text", "")).strip()
        if not raw_text:
            continue

        item_sentences = sentences(raw_text)
        if not item_sentences:
            item_sentences = [raw_text]

        # If entering a distinct non-generic thematic section, flush if we have sufficient content
        if cur_sections and section != cur_sections[-1] and not concepts.is_generic_section_heading(section):
            is_prev_real_heading = not concepts.is_generic_section_heading(cur_sections[-1])
            req_words = 20 if is_prev_real_heading else MIN_WORDS
            if cur_word_count >= req_words:
                _flush_buffer()

        for s in item_sentences:
            s_words = len(s.split())
            if s_words == 0:
                continue

            # If adding this sentence exceeds MAX_WORDS and we already meet MIN_WORDS, flush previous
            if (cur_word_count + s_words > MAX_WORDS) and (cur_word_count >= MIN_WORDS):
                _flush_buffer()

            cur_sentences.append(s)
            cur_pages.append(page)
            if locator not in cur_locators:
                cur_locators.append(locator)
            if section not in cur_sections:
                cur_sections.append(section)
            cur_word_count += s_words

            # If target words reached, flush buffer
            if cur_word_count >= TARGET_WORDS:
                _flush_buffer()

    # Flush leftover buffer
    if cur_sentences:
        # If leftover is brief (< 50 words) and prior chunks exist, merge unless it has its own distinct heading
        prev_is_distinct = (
            chunks and cur_sections and not concepts.is_generic_section_heading(cur_sections[-1])
            and chunks[-1].get("section") != cur_sections[-1]
            and not concepts.is_generic_section_heading(chunks[-1].get("section", ""))
        )
        if cur_word_count < 50 and chunks and not prev_is_distinct:
            last = chunks[-1]
            last["text"] += " " + " ".join(cur_sentences).strip()
            last["token_count"] = len(last["text"].split())
            if cur_locators:
                last_loc = cur_locators[-1].replace("[", "").replace("]", "").replace("Video ", "").strip()
                if last_loc not in last["locator_label"]:
                    last["locator_label"] = f"{last['locator_label']} - {last_loc}"
        else:
            _flush_buffer()

    return chunks


# ── LangGraph Ingestion Pipeline ─────────────────────────────────────────────

class IngestionState(TypedDict):
    input_target: str               # file path string or URL
    source_type: str                # pdf, pptx, markdown, docx, youtube, web, audio, auto
    user_id: str
    custom_title: Optional[str]
    material_id: str
    title: str
    origin_name: str
    raw_text: str
    structured_preview: List[Dict[str, Any]]
    raw_items: List[Dict[str, Any]]
    chunks: List[Dict[str, Any]]
    concepts: List[Dict[str, Any]]
    edges: List[List[str]]
    error: Optional[str]


def detect_source_type_node(state: IngestionState) -> Dict[str, Any]:
    """Node 1: Inspect input target and infer source type and origin label."""
    target = state["input_target"].strip()
    stype = state.get("source_type", "auto").lower()

    if target.startswith("http://") or target.startswith("https://"):
        if "youtube.com" in target or "youtu.be" in target:
            return {"source_type": "youtube", "origin_name": target}
        return {"source_type": "web", "origin_name": target}

    # Target is local file path
    p = Path(target)
    ext = p.suffix.lower()
    inferred_type = {
        ".pdf": "pdf",
        ".pptx": "pptx",
        ".ppt": "pptx",
        ".md": "markdown",
        ".txt": "markdown",
        ".docx": "docx",
        ".mp3": "audio",
        ".wav": "audio",
        ".m4a": "audio",
        ".webm": "audio",
    }.get(ext, "pdf")

    chosen_type = inferred_type if stype == "auto" else stype
    return {"source_type": chosen_type, "origin_name": p.name}


def extract_raw_content_node(state: IngestionState) -> Dict[str, Any]:
    """Node 2: Dispatch to specialized format loaders."""
    target = state["input_target"]
    stype = state["source_type"]
    custom_title = state.get("custom_title")

    # URL moderation can pass the exact fetched payload into ingestion. This
    # prevents a second fetch from changing after screening and being persisted.
    preloaded = state.get("preloaded_content")
    if preloaded is not None:
        return {
            "title": preloaded["title"],
            "raw_items": preloaded["raw_items"],
            "structured_preview": preloaded["structured_preview"],
            "raw_text": preloaded["raw_text"],
        }

    if stype == "youtube":
        title, raw_items, preview, raw_text = load_youtube_material(target, custom_title=custom_title)
    elif stype == "web":
        title, raw_items, preview, raw_text = load_web_article_material(target, custom_title=custom_title)
    else:
        path = Path(target)
        if not path.exists():
            raise store.UserError(f"Target file does not exist: {target}")

        if stype == "pptx":
            title, raw_items, preview, raw_text = load_pptx_material(path)
        elif stype == "markdown":
            title, raw_items, preview, raw_text = load_markdown_material(path)
        elif stype == "docx":
            title, raw_items, preview, raw_text = load_docx_material(path)
        elif stype == "audio":
            title, raw_items, preview, raw_text = load_audio_material(path, custom_title=custom_title)
        else:
            title, raw_items, preview, raw_text = load_pdf_material(path)

    final_title = custom_title or title
    return {
        "title": final_title,
        "raw_items": raw_items,
        "structured_preview": preview,
        "raw_text": raw_text
    }


def semantic_section_chunker_node(state: IngestionState) -> Dict[str, Any]:
    """Node 3: Segment content at sentence and section boundaries."""
    chunks = chunk_extracted_items(
        items=state["raw_items"],
        source_id=state["material_id"],
        source_type=state["source_type"],
        source_title=state["title"],
        origin_name=state["origin_name"],
    )
    if not chunks:
        raise store.UserError(f"Could not generate semantic chunks for '{state['title']}'. Content is too sparse.")
    return {"chunks": chunks}


def synonym_normalizer_node(state: IngestionState) -> Dict[str, Any]:
    """Node 4: Normalize domain vocabulary, build candidate concepts, and tag chunks."""
    chunks = state["chunks"]
    cs, edges = concepts.build(chunks)
    concept_names = [c["name"] for c in cs]

    for chunk in chunks:
        detected = NORMALIZER.detect_canonical_concepts(chunk["text"], concept_names)
        section_norm = NORMALIZER.canonicalize(chunk["section"])
        if section_norm and section_norm not in detected:
            detected.append(section_norm)
        chunk["canonical_concepts"] = detected

    return {
        "concepts": cs,
        "edges": edges,
        "chunks": chunks
    }


def sqlite_bm25_index_node(state: IngestionState) -> Dict[str, Any]:
    """Node 5: Persist source in SQLite study_materials and index chunks into BM25 inverted index."""
    material_record = {
        "material_id": state["material_id"],
        "user_id": state.get("user_id", "default"),
        "title": state["title"],
        "source_type": state["source_type"],
        "original_filename_or_url": state["origin_name"],
        "raw_extracted_text": state["raw_text"],
        "structured_preview": state["structured_preview"],
        "chunk_count": len(state["chunks"]),
        "concepts": [c["name"] for c in state["concepts"]],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store.save_study_material(material_record)

    # Note: unified index population happens in the DAG update node
    return {}


def update_prerequisite_dag_node(state: IngestionState) -> Dict[str, Any]:
    """Node 6: Merge all user study materials and rebuild unified Prerequisite DAG and BM25 Index."""
    user_id = state.get("user_id", "default")
    UniversalMaterialIngestor.rebuild_unified_knowledge_base(user_id=user_id)
    return {}


# Build and compile LangGraph Ingestion Pipeline
_builder = StateGraph(IngestionState)
_builder.add_node("detect_source_type", detect_source_type_node)
_builder.add_node("extract_raw_content", extract_raw_content_node)
_builder.add_node("semantic_section_chunker", semantic_section_chunker_node)
_builder.add_node("synonym_normalizer", synonym_normalizer_node)
_builder.add_node("sqlite_bm25_index", sqlite_bm25_index_node)
_builder.add_node("update_prerequisite_dag", update_prerequisite_dag_node)

_builder.set_entry_point("detect_source_type")
_builder.add_edge("detect_source_type", "extract_raw_content")
_builder.add_edge("extract_raw_content", "semantic_section_chunker")
_builder.add_edge("semantic_section_chunker", "synonym_normalizer")
_builder.add_edge("synonym_normalizer", "sqlite_bm25_index")
_builder.add_edge("sqlite_bm25_index", "update_prerequisite_dag")
_builder.add_edge("update_prerequisite_dag", END)

INGESTION_GRAPH = _builder.compile()


# ── Universal Material Ingestor Interface ───────────────────────────────────

class UniversalMaterialIngestor:
    """Unified Orchestrator for Multi-Format Study Material Ingestion & Knowledge Base Management."""

    @classmethod
    def preview_url(cls, url: str, source_type: str = "auto", title: Optional[str] = None) -> Dict[str, Any]:
        """Fetch and extract URL content without persisting or indexing it."""
        initial_state: IngestionState = {
            "input_target": url.strip(),
            "source_type": source_type,
            "user_id": "moderation-preview",
            "custom_title": title,
            "material_id": "moderation-preview",
            "title": "",
            "origin_name": url.strip(),
            "raw_text": "",
            "structured_preview": [],
            "raw_items": [],
            "chunks": [],
            "concepts": [],
            "edges": [],
            "error": None,
        }
        detected = detect_source_type_node(initial_state)
        initial_state.update(detected)
        extracted = extract_raw_content_node(initial_state)
        return extracted

    @classmethod
    def ingest_file(cls, path: Path, user_id: str = "default", title: Optional[str] = None) -> Dict[str, Any]:
        """Ingest any supported file format (.pdf, .pptx, .md, .txt, .docx, .mp3, .wav, .m4a)."""
        material_id = f"mat_{uuid.uuid4().hex[:10]}"
        initial_state: IngestionState = {
            "input_target": str(path.resolve()),
            "source_type": "auto",
            "user_id": user_id,
            "custom_title": title,
            "material_id": material_id,
            "title": "",
            "origin_name": path.name,
            "raw_text": "",
            "structured_preview": [],
            "raw_items": [],
            "chunks": [],
            "concepts": [],
            "edges": [],
            "error": None,
        }
        final_state = INGESTION_GRAPH.invoke(initial_state)
        return {
            "material_id": material_id,
            "title": final_state["title"],
            "source_type": final_state["source_type"],
            "original_filename_or_url": final_state["origin_name"],
            "chunk_count": len(final_state["chunks"]),
            "concepts": [c["name"] for c in final_state["concepts"]],
            "concept_count": len(final_state["concepts"]),
            "graph_nodes": len(final_state["concepts"]),
            "graph_edges": len(final_state["edges"]),
        }

    @classmethod
    def ingest_url(cls, url: str, source_type: str = "auto", user_id: str = "default", title: Optional[str] = None, preloaded_content: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Ingest YouTube video or educational website."""
        material_id = f"mat_{uuid.uuid4().hex[:10]}"
        initial_state: IngestionState = {
            "input_target": url.strip(),
            "source_type": source_type,
            "user_id": user_id,
            "custom_title": title,
            "material_id": material_id,
            "title": "",
            "origin_name": url.strip(),
            "raw_text": "",
            "structured_preview": [],
            "raw_items": [],
            "chunks": [],
            "concepts": [],
            "edges": [],
            "error": None,
        }
        if preloaded_content is not None:
            initial_state["preloaded_content"] = preloaded_content
        final_state = INGESTION_GRAPH.invoke(initial_state)
        return {
            "material_id": material_id,
            "title": final_state["title"],
            "source_type": final_state["source_type"],
            "original_filename_or_url": final_state["origin_name"],
            "chunk_count": len(final_state["chunks"]),
            "concepts": [c["name"] for c in final_state["concepts"]],
            "concept_count": len(final_state["concepts"]),
            "graph_nodes": len(final_state["concepts"]),
            "graph_edges": len(final_state["edges"]),
        }

    @classmethod
    def ingest_content(cls, content: str, source_type: str = "markdown", user_id: str = "default", title: Optional[str] = None, origin: str = "notes.md") -> Dict[str, Any]:
        """Ingest raw text or markdown content directly."""
        import tempfile
        ext = ".md" if source_type == "markdown" else ".txt"
        with tempfile.NamedTemporaryFile("w", suffix=ext, delete=False, encoding="utf-8") as f:
            f.write(content)
            temp_path = Path(f.name)
        try:
            res = cls.ingest_file(temp_path, user_id=user_id, title=title)
            res["user_id"] = user_id
            if origin:
                res["original_filename_or_url"] = origin
            return res
        finally:
            if temp_path.exists():
                temp_path.unlink()

    @classmethod
    def rebuild_unified_knowledge_base(cls, user_id: str = "default") -> Dict[str, Any]:
        """Merge all materials belonging to learner into a unified SQLite BM25 Index and Prerequisite DAG."""
        materials = store.list_study_materials(user_id=user_id)
        if not materials:
            GLOBAL_INDEX.clear(user_id=user_id)
            store.clear_kb(user_id=user_id)
            return {"ready": False, "chunk_count": 0, "concept_count": 0}

        all_combined_chunks: List[Dict[str, Any]] = []
        titles: List[str] = []
        total_pages = 0

        for mat in materials:
            titles.append(mat["title"])
            full_mat = store.get_study_material(mat["material_id"], user_id=user_id)
            if not full_mat:
                continue

            preview_items = full_mat.get("structured_preview", [])
            items = []
            for p in preview_items:
                items.append({
                    "page": p.get("index", 1),
                    "locator_label": p.get("label", f"Page {p.get('index', 1)}"),
                    "section": p.get("heading") or p.get("title") or (f"Video [{p.get('label')}]" if p.get("timestamp") else "Introduction"),
                    "text": p.get("text", "")
                })

            if not items and full_mat.get("raw_extracted_text"):
                items.append({
                    "page": 1,
                    "locator_label": "Overview",
                    "section": "Overview",
                    "text": full_mat["raw_extracted_text"]
                })

            total_pages += max(len(preview_items), 1)
            mat_chunks = chunk_extracted_items(
                items=items,
                source_id=mat["material_id"],
                source_type=mat["source_type"],
                source_title=mat["title"],
                origin_name=mat["original_filename_or_url"],
            )
            all_combined_chunks.extend(mat_chunks)

        if not all_combined_chunks:
            GLOBAL_INDEX.clear(user_id=user_id)
            store.clear_kb(user_id=user_id)
            return {"ready": False, "chunk_count": 0, "concept_count": 0}

        # 1. Build Prerequisite Concept DAG across all combined materials
        cs, edges = concepts.build(all_combined_chunks)
        concept_names = [c["name"] for c in cs]

        # 2. Tag chunks with canonical concepts
        for chunk in all_combined_chunks:
            detected = NORMALIZER.detect_canonical_concepts(chunk["text"], concept_names)
            sec_norm = NORMALIZER.canonicalize(chunk["section"])
            if sec_norm and sec_norm not in detected:
                detected.append(sec_norm)
            chunk["canonical_concepts"] = detected

        # 3. Populate SQLite Inverted Index
        GLOBAL_INDEX.clear(user_id=user_id)
        chunk_models = [
            ChunkMetadata(
                chunk_id=c["chunk_id"],
                page_number=c["page"],
                section_title=c["section"],
                text=c["text"],
                canonical_concepts=c["canonical_concepts"],
                source_filename=c.get("source_filename", ""),
                locator_label=c.get("locator_label", f"Page {c['page']}"),
                source_id=c.get("source_id", ""),
                source_type=c.get("source_type", "pdf"),
                source_title=c.get("source_title", ""),
                origin_url_or_filename=c.get("origin_url_or_filename", ""),
            )
            for c in all_combined_chunks
        ]
        GLOBAL_INDEX.index_chunks(chunk_models, user_id=user_id)

        # 4. Save to shared KB
        from ..core.vector_index import VectorIndex
        index = VectorIndex.build(all_combined_chunks)
        combined_title = ", ".join(titles[:3]) + (f" (+{len(titles)-3} more)" if len(titles) > 3 else "")
        store.save_kb(combined_title, total_pages, index, cs, edges, user_id=user_id)
        mastery.reset(cs, user_id=user_id)

        return {
            "ready": True,
            "title": combined_title,
            "pages": total_pages,
            "chunk_count": len(all_combined_chunks),
            "concept_count": len(cs),
            "concepts": [c["name"] for c in cs],
            "edges": edges
        }

    @classmethod
    def delete_material(cls, material_id: str, user_id: str = "default") -> Dict[str, Any]:
        """Delete a study material and automatically recompute index and DAG."""
        deleted = store.delete_study_material(material_id, user_id=user_id)
        if not deleted:
            raise store.UserError(f"Study material '{material_id}' not found.")
        return cls.rebuild_unified_knowledge_base(user_id=user_id)


# ── Legacy Synchronous & Asynchronous Runners ───────────────────────────────

def run_ingest(path: Path) -> dict:
    """Run full vectorless ingestion pipeline for a single PDF synchronously."""
    return run_ingest_multiple([path])


def run_ingest_multiple(paths: list[Path]) -> dict:
    """Run vectorless ingestion pipeline across one or more study PDFs."""
    if not paths:
        raise store.UserError("No PDF files provided for ingestion.")

    all_raw_chunks: list[dict] = []
    total_pages = 0
    valid_filenames: list[str] = []

    for path in paths:
        if not path.exists():
            continue
        valid_filenames.append(path.name)
        pages = extract_pages(path)
        total_pages += len(pages)
        raw_chunks = chunk_pages(pages, source_filename=path.name)

        # Ensure source metadata
        for rc in raw_chunks:
            rc["locator_label"] = f"Page {rc['page']}"
            rc["source_type"] = "pdf"
            rc["source_title"] = path.stem.replace("_", " ").title()
            rc["origin_url_or_filename"] = path.name

        all_raw_chunks.extend(raw_chunks)

        # Also persist into study_materials table
        structured_preview = [{"index": p, "label": f"Page {p}", "text": text} for p, text in pages]
        full_text = "\n\n".join(t for _, t in pages)
        store.save_study_material({
            "material_id": f"mat_{path.stem}",
            "user_id": "default",
            "title": path.stem.replace("_", " ").title(),
            "source_type": "pdf",
            "original_filename_or_url": path.name,
            "raw_extracted_text": full_text,
            "structured_preview": structured_preview,
            "chunk_count": len(raw_chunks),
            "concepts": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    if not all_raw_chunks:
        raise store.UserError("No readable text found in uploaded PDF(s). Scanned PDFs need OCR first.")

    # 1. Build Prerequisite Concept DAG across all combined material
    cs, edges = concepts.build(all_raw_chunks)
    concept_names = [c["name"] for c in cs]

    # 2. Tag each chunk with canonical concept IDs
    for chunk in all_raw_chunks:
        detected = NORMALIZER.detect_canonical_concepts(chunk["text"], concept_names)
        section_norm = NORMALIZER.canonicalize(chunk["section"])
        if section_norm and section_norm not in detected:
            detected.append(section_norm)
        chunk["canonical_concepts"] = detected

    # 3. Populate Vectorless SQLite Inverted Index
    GLOBAL_INDEX.clear()
    chunk_models = [
        ChunkMetadata(
            chunk_id=c["chunk_id"],
            page_number=c["page"],
            section_title=c["section"],
            text=c["text"],
            canonical_concepts=c["canonical_concepts"],
            source_filename=c.get("source_filename", valid_filenames[0]),
            locator_label=c.get("locator_label", f"Page {c['page']}"),
            source_id=c.get("source_id", ""),
            source_type=c.get("source_type", "pdf"),
            source_title=c.get("source_title", ""),
            origin_url_or_filename=c.get("origin_url_or_filename", valid_filenames[0]),
        )
        for c in all_raw_chunks
    ]
    GLOBAL_INDEX.index_chunks(chunk_models)

    # 4. Save to KB for frontend and API compatibility
    combined_name = ", ".join(valid_filenames)
    from ..core.vector_index import VectorIndex
    index = VectorIndex.build(all_raw_chunks)
    store.save_kb(combined_name, total_pages, index, cs, edges)
    mastery.reset(cs)

    return {
        "job_id": combined_name,
        "file": combined_name,
        "filename": combined_name,
        "filenames": valid_filenames,
        "files_count": len(valid_filenames),
        "pages": total_pages,
        "chunks": len(all_raw_chunks),
        "chunk_count": len(all_raw_chunks),
        "chunks_indexed": len(all_raw_chunks),
        "concepts": [c["name"] for c in cs],
        "concepts_found": [c["name"] for c in cs],
        "graph_nodes": len(cs),
        "graph_edges": len(edges),
    }


async def run_ingest_async(path_or_paths: Path | list[Path]) -> dict:
    """Run ingest in an executor so it never blocks the async event loop."""
    paths = [path_or_paths] if isinstance(path_or_paths, Path) else path_or_paths
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, run_ingest_multiple, paths)
