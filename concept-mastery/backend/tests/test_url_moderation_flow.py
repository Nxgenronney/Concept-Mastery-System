"""Regression tests proving URL moderation runs before persistence/indexing."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app import routes


def request_for_url():
    return SimpleNamespace(
        url="https://example.test/study",
        source_type="auto",
        title=None,
        user_id="test_url_moderation",
    )


@pytest.mark.asyncio
async def test_explicit_url_is_rejected_before_ingestion(monkeypatch):
    preview = {
        "title": "Restricted page",
        "raw_items": [{"text": "hardcore porn"}],
        "structured_preview": [],
        "raw_text": "hardcore porn",
    }
    ingest = Mock(side_effect=AssertionError("ingestion must not run for blocked content"))
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "preview_url", Mock(return_value=preview))
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "ingest_url", ingest)
    monkeypatch.setattr(routes.store, "is_medical_verified", Mock(return_value=False))

    with pytest.raises(HTTPException) as exc:
        await routes.post_materials_ingest_url(request_for_url(), current_user=None)

    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "MEDICAL_VERIFICATION_REQUIRED"
    ingest.assert_not_called()


@pytest.mark.asyncio
async def test_unextractable_url_is_rejected_before_ingestion(monkeypatch):
    preview = {
        "title": "Image-only page",
        "raw_items": [],
        "structured_preview": [],
        "raw_text": "",
    }
    ingest = Mock(side_effect=AssertionError("unscannable content must not be ingested"))
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "preview_url", Mock(return_value=preview))
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "ingest_url", ingest)

    with pytest.raises(HTTPException) as exc:
        await routes.post_materials_ingest_url(request_for_url(), current_user=None)

    assert exc.value.status_code == 422
    ingest.assert_not_called()


@pytest.mark.asyncio
async def test_safe_url_ingests_the_exact_payload_that_was_screened(monkeypatch):
    preview = {
        "title": "Gradient Descent",
        "raw_items": [{"text": "Gradient descent minimizes a loss function."}],
        "structured_preview": [{"label": "Introduction", "text": "Gradient descent minimizes a loss function."}],
        "raw_text": "Gradient descent minimizes a loss function.",
    }
    ingest = Mock(return_value={"material_id": "mat_safe"})
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "preview_url", Mock(return_value=preview))
    monkeypatch.setattr(routes.UniversalMaterialIngestor, "ingest_url", ingest)
    monkeypatch.setattr(routes.store, "get_kb", Mock(return_value={"ready": True, "file": "Gradient Descent", "pages": 1, "concepts": ["Gradient Descent"]}))

    result = await routes.post_materials_ingest_url(request_for_url(), current_user=None)

    assert result["ok"] is True
    assert result["material"]["material_id"] == "mat_safe"
    ingest.assert_called_once()
    assert ingest.call_args.kwargs["preloaded_content"] is preview
