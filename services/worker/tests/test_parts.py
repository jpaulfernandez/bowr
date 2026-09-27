"""P1.04: grouped-photo proposals and confirmed-part crops."""

from __future__ import annotations

import hashlib
import io
import json

import httpx
import pytest
from PIL import Image

from bowr_worker.media import MediaRejected
from bowr_worker.parts import MAX_PARTS, PROPOSAL_MODEL, crop, propose_parts
from bowr_worker.pipeline import run_job
from bowr_worker.validation import validate

from .conftest import accessories, encode, garment


def _inside(box: dict[str, float], x: float, y: float) -> bool:
    return box["x"] <= x <= box["x"] + box["w"] and box["y"] <= y <= box["y"] + box["h"]


def test_separate_pieces_in_a_grouped_photo_are_proposed_as_normalized_boxes() -> None:
    proposals = propose_parts(accessories(), PROPOSAL_MODEL)
    assert len(proposals) == 2
    for box in proposals:
        assert set(box) == {"x", "y", "w", "h"}
        assert 0 <= box["x"] and 0 <= box["y"] and box["x"] + box["w"] <= 1 and box["y"] + box["h"] <= 1
    # The watch (left) and the bracelet (right) each fall in exactly one proposal.
    watch = [b for b in proposals if _inside(b, 175 / 800, 300 / 600)]
    bracelet = [b for b in proposals if _inside(b, 580 / 800, 200 / 600)]
    assert len(watch) == 1 and len(bracelet) == 1 and watch != bracelet
    assert len(proposals) <= MAX_PARTS


def test_an_unavailable_model_proposes_nothing_so_the_member_draws_rectangles() -> None:
    assert propose_parts(accessories(), "no_such_model") == []


def test_a_crop_is_its_own_sanitized_image_of_the_confirmed_box() -> None:
    source = encode(garment(), "WEBP")
    part = crop(source, {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.5})
    assert (part.width, part.height) == (400, 300)
    with Image.open(io.BytesIO(part.data)) as image:
        assert image.format == "WEBP" and image.size == (400, 300)
        assert not image.info.get("exif")


def test_a_crop_smaller_than_the_minimum_or_of_corrupt_bytes_is_rejected() -> None:
    source = encode(garment(), "WEBP")
    with pytest.raises(MediaRejected):
        crop(source, {"x": 0.5, "y": 0.5, "w": 0.01, "h": 0.01})
    with pytest.raises(MediaRejected):
        crop(b"not an image", {"x": 0, "y": 0, "w": 1, "h": 1})


JOB_ID = "11111111-2222-4333-8444-555555555555"


def _crop_claim() -> dict[str, object]:
    return {
        "schema_version": 1,
        "job_id": JOB_ID,
        "kind": "item_stage",
        "stage": "crop",
        "lease_generation": 1,
        "lease_expires_at": "2026-09-26T10:00:00Z",
        "capability": "capability-token-for-this-job-only",
        "input": {
            "box": {"x": 0.5, "y": 0.25, "w": 0.4, "h": 0.5},
            "source": {"width": 800, "height": 600},
            "max_bytes": 1 << 22,
        },
        "sources": {"source": {"url": "http://store.test/source"}},
        "outputs": {"original": {"url": "http://store.test/out", "content_type": "image/webp"}},
    }


def test_the_crop_stage_writes_one_signed_original_and_completes_with_its_checksum() -> None:
    validate("worker_claim_response", _crop_claim())
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/jobs/claim":
            return httpx.Response(200, json={"data": _crop_claim()})
        if request.url.path == "/source":
            return httpx.Response(200, content=encode(accessories(), "WEBP"))
        if request.url.path == "/out":
            return httpx.Response(200)
        if request.url.path == f"/v1/jobs/{JOB_ID}/complete":
            return httpx.Response(200, json={"data": {"status": "applied"}})
        return httpx.Response(500)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        outcome = run_job({"job_id": JOB_ID, "claim_token": "c" * 64}, "http://internal.test", client)
    assert outcome == "ready:applied"
    assert [c.url.path for c in calls] == ["/v1/jobs/claim", "/source", "/out", f"/v1/jobs/{JOB_ID}/complete"]
    body = json.loads(calls[-1].content)
    validate("item_stage_complete_request", body)
    written = calls[2].content
    assert body["outputs"]["original"] == {
        "width": 320,
        "height": 300,
        "byte_size": len(written),
        "sha256": hashlib.sha256(written).hexdigest(),
    }
