"""P1.05: cutouts composed from a member-edited mask (never from client cutout bytes)."""

from __future__ import annotations

import io
import json

import httpx
import numpy as np
import pytest
from PIL import Image

from bowr_worker.cutout import cutout_from_mask
from bowr_worker.media import MediaRejected
from bowr_worker.pipeline import run_job
from bowr_worker.validation import validate

from .conftest import encode, garment, garment_truth
from .test_cutout import JOB_ID, stage_claim


def truth_mask() -> np.ndarray:
    return np.where(np.asarray(garment_truth()), 255, 0).astype(np.uint8)


def test_the_composed_cutout_follows_the_edited_mask_exactly() -> None:
    mask = truth_mask()
    # The member erases the left sleeve.
    mask[:, :280] = 0
    result = cutout_from_mask(
        encode(garment(), "WEBP", quality=95), encode(Image.fromarray(mask, "L"), "PNG")
    )
    stored = np.asarray(Image.open(io.BytesIO(result.mask.data)))
    assert stored.shape == (600, 800)
    assert np.array_equal(stored, mask)
    cut = Image.open(io.BytesIO(result.cutout.data))
    assert cut.mode == "RGBA" and cut.size == (1024, 1024)


def test_a_mask_of_another_size_or_format_is_rejected() -> None:
    original = encode(garment(), "WEBP")
    with pytest.raises(MediaRejected):
        cutout_from_mask(original, encode(Image.new("L", (600, 800), 255), "PNG"))
    # A client-made "cutout" in place of the mask is not accepted.
    forged = encode(Image.new("RGBA", (800, 600), (10, 20, 30, 255)), "WEBP")
    with pytest.raises(MediaRejected):
        cutout_from_mask(original, forged)
    with pytest.raises(MediaRejected):
        cutout_from_mask(original, encode(Image.new("L", (800, 600), 0), "PNG"))


def test_a_manual_cutout_downloads_the_original_and_the_mask_then_uploads_three_renditions() -> None:
    claim = stage_claim("manual")
    claim["sources"]["mask"] = {"url": "http://store.test/edited-mask"}
    validate("worker_claim_response", claim)
    mask = encode(Image.fromarray(truth_mask(), "L"), "PNG")
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/jobs/claim":
            return httpx.Response(200, json={"data": claim})
        if request.url.path == "/original":
            return httpx.Response(200, content=encode(garment(), "WEBP"))
        if request.url.path == "/edited-mask":
            return httpx.Response(200, content=mask)
        if request.url.path in {"/cutout", "/thumbnail", "/mask"}:
            return httpx.Response(200)
        if request.url.path == f"/v1/jobs/{JOB_ID}/complete":
            return httpx.Response(200, json={"data": {"status": "applied"}})
        return httpx.Response(500)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        outcome = run_job({"job_id": JOB_ID, "claim_token": "b" * 64}, "http://internal.test", client)
    assert outcome == "ready:applied"
    assert [c.url.path for c in calls][:3] == ["/v1/jobs/claim", "/original", "/edited-mask"]
    validate("item_stage_complete_request", json.loads(calls[-1].content))
