"""Validation Suite for OpenRouter Unified LLM Gateway & Prompt Normalization.

Tests:
  1. OpenRouter Configuration & Frontier Fallback Chain.
  2. Central Output Sanitizer (<think> / <thought> / <reasoning> blocks).
  3. JSON Payload Extractor (Markdown fences, surrounding commentary, nested JSON).
  4. Auto-Failover Payload & Batch Construction (models array <= 3 limit).
  5. Live OpenRouter Request with Native Fallback Execution.
  6. Offline Deterministic Fallback Guardrail for Automated Test Suites.
"""

import json
import os
import pytest
from app import config
from app.core import llm


def test_openrouter_configuration():
    """Verify OpenRouter base url, key loading, and prioritized fallback chain."""
    assert config.OPENROUTER_BASE_URL.rstrip("/") == "https://openrouter.ai/api/v1"
    assert isinstance(config.OPENROUTER_API_KEY, str)
    assert len(config.OPENROUTER_MODELS) == 6
    assert config.OPENROUTER_MODELS == [
        "google/gemini-2.5-flash",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "deepseek/deepseek-chat-v3-0324:free",
        "nvidia/nemotron-3.5-super-vl:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "openrouter/auto",
    ]


def test_sanitize_llm_response_removes_thinking_blocks():
    """Verify central sanitizer strips <think>, <thought>, <reasoning> blocks."""
    # Standard closed think block
    raw1 = "<think>Let me reason about this concept step-by-step.</think>Final answer."
    assert llm.sanitize_llm_response(raw1) == "Final answer."

    # Multiline case-insensitive think block
    raw2 = "<THINK>\nAnalyzing student reasoning: lucky guess detected.\nScore should be 0.35.\n</THINK>\n{\"status\": \"WEAK\"}"
    assert llm.sanitize_llm_response(raw2) == '{"status": "WEAK"}'

    # Alternative thought/reasoning tags
    raw3 = "<thought>Thinking...</thought><reasoning>Deep reasoning</reasoning>Done."
    assert llm.sanitize_llm_response(raw3) == "Done."

    # Unclosed trailing think block (truncated generation)
    raw4 = "<think>Model started thinking but ran out of tokens"
    assert llm.sanitize_llm_response(raw4) == ""

    # Empty and None handling
    assert llm.sanitize_llm_response("") == ""
    assert llm.sanitize_llm_response(None) == ""


def test_extract_json_payload():
    """Verify extraction of JSON from markdown code fences and surrounding text."""
    # Markdown json fence
    raw1 = "```json\n{\"concept_id\": \"loss-functions\", \"status\": \"STRONG\"}\n```"
    parsed1 = json.loads(llm.extract_json_payload(raw1))
    assert parsed1["concept_id"] == "loss-functions"
    assert parsed1["status"] == "STRONG"

    # Thinking tags + Markdown code fence
    raw2 = (
        "<think>Evaluate student explanation</think>\n"
        "Here is the result:\n"
        "```\n"
        "{\n  \"epistemic_status\": \"WEAK\",\n  \"semantic_comprehension_score\": 0.42\n}\n"
        "```\n"
        "Hope this helps!"
    )
    parsed2 = json.loads(llm.extract_json_payload(raw2))
    assert parsed2["epistemic_status"] == "WEAK"
    assert parsed2["semantic_comprehension_score"] == 0.42

    # Array JSON extraction
    raw3 = "Output:\n[{\"concept\": \"Backpropagation\", \"definition\": \"Gradient calculation.\"}]\n"
    parsed3 = json.loads(llm.extract_json_payload(raw3))
    assert isinstance(parsed3, list)
    assert parsed3[0]["concept"] == "Backpropagation"


def test_openrouter_batch_partitioning():
    """Verify models are grouped into sub-batches of at most 3 models to satisfy OpenRouter constraints."""
    models_pool = config.OPENROUTER_MODELS
    batches = [models_pool[i:i + 3] for i in range(0, len(models_pool), 3)]
    assert len(batches) == 2
    assert len(batches[0]) == 3
    assert len(batches[1]) == 3
    assert batches[0] == [
        "google/gemini-2.5-flash",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "deepseek/deepseek-chat-v3-0324:free",
    ]
    assert batches[1] == [
        "nvidia/nemotron-3.5-super-vl:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "openrouter/auto",
    ]


def test_offline_deterministic_fallback_guardrail():
    """Verify that during offline execution or empty key, deterministic local engine is used."""
    # Force offline test flag
    assert llm.is_offline() is True
    assert llm.enabled() is False
    assert llm.complete("System", "User") is None


def test_live_openrouter_execution(monkeypatch):
    """Verify live OpenRouter completion and fallback when key is active and live mode is enabled."""
    if not config.OPENROUTER_API_KEY or os.getenv("OFFLINE_TEST") == "1":
        pytest.skip("OPENROUTER_API_KEY not configured or offline test mode enabled.")

    # Enable live execution for this test
    monkeypatch.setenv("OPENROUTER_LIVE", "1")
    assert llm.is_offline() is False
    assert llm.enabled() is True

    llm.reset_exhaustion_state()
    res = llm.complete(
        system="You are a precise grading bot. Respond with ONLY valid JSON.",
        user="Respond with a JSON object containing key 'status' with value 'ONLINE'.",
        max_tokens=100,
    )
    assert res is not None
    payload = json.loads(llm.extract_json_payload(res))
    assert payload.get("status") == "ONLINE"

