"""Cutout stage with the pinned CPU models (fetched by `pnpm worker:models`)."""

from __future__ import annotations

import io
import json
import logging

import httpx
import numpy as np
import pytest
from PIL import Image

from bowr_worker import models
from bowr_worker.cutout import CUTOUT_EDGE, THUMBNAIL_EDGE, cutout
from bowr_worker.media import MediaRejected
from bowr_worker.pipeline import run_job
from bowr_worker.validation import validate

from .conftest import encode, garment, garment_truth

MODELS = ["isnet_general_use", "u2netp"]


@pytest.mark.parametrize("model", MODELS)
def test_a_garment_becomes_a_square_transparent_cutout_thumbnail_and_matching_mask(model: str) -> None:
    result = cutout(encode(garment(), "WEBP", quality=95), model)

    cut = Image.open(io.BytesIO(result.cutout.data))
    assert (cut.format, cut.mode, cut.size) == ("WEBP", "RGBA", (CUTOUT_EDGE, CUTOUT_EDGE))
    thumb = Image.open(io.BytesIO(result.thumbnail.data))
    assert (thumb.format, thumb.mode, thumb.size) == ("WEBP", "RGBA", (THUMBNAIL_EDGE, THUMBNAIL_EDGE))
    mask = Image.open(io.BytesIO(result.mask.data))
    assert (mask.format, mask.mode, mask.size) == ("PNG", "L", (800, 600))

    # The mask finds the shirt, not the background.
    truth = np.asarray(garment_truth())
    found = np.asarray(mask) >= 128
    assert (found & truth).sum() / (found | truth).sum() > 0.9
    assert abs(result.foreground_ratio - truth.mean()) < 0.05

    # Corners are transparent and the garment keeps a safe margin of about 10%.
    alpha = np.asarray(cut)[:, :, 3]
    assert alpha[0, 0] == alpha[-1, -1] == 0
    rows, cols = np.flatnonzero((alpha > 128).any(axis=1)), np.flatnonzero((alpha > 128).any(axis=0))
    assert rows[0] >= 90 and cols[0] >= 90 and rows[-1] <= CUTOUT_EDGE - 90 and cols[-1] <= CUTOUT_EDGE - 90
    # The garment's own color survives (no tint): navy inside the cutout.
    r, g, b, _ = np.asarray(cut)[CUTOUT_EDGE // 2, CUTOUT_EDGE // 2]
    assert (int(r), int(g), int(b)) == pytest.approx((31, 42, 77), abs=12)
    assert result.cutout.describe()["sha256"] == result.cutout.sha256


@pytest.mark.parametrize("model", MODELS)
def test_a_photo_without_a_garment_is_rejected_instead_of_mislabeled_ready(model: str) -> None:
    blank = encode(Image.new("RGB", (640, 480), (200, 200, 200)), "WEBP")
    with pytest.raises(MediaRejected) as rejected:
        cutout(blank, model)
    assert rejected.value.code == "NO_FOREGROUND"


def test_corrupt_original_bytes_are_rejected() -> None:
    with pytest.raises(MediaRejected) as rejected:
        cutout(b"RIFF\x00\x00\x00\x00WEBPnot really", "u2netp")
    assert rejected.value.code == "CORRUPT_IMAGE"


def test_missing_or_altered_weights_are_unavailable_never_downloaded(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(models, "MODEL_DIR", tmp_path)
    monkeypatch.setattr(models, "_sessions", {})
    with pytest.raises(models.ModelUnavailable):
        models.session("u2netp")
    (tmp_path / "u2netp.onnx").write_bytes(b"tampered weights")
    with pytest.raises(models.ModelUnavailable):
        models.session("u2netp")
    with pytest.raises(models.ModelUnavailable):
        models.session("not_in_the_manifest")


JOB_ID = "0b8e3c1a-5d4f-4e6a-9b7c-2d1e0f3a4b5c"
SIGNED = "X-Amz-Signature=secret-signature"


def stage_claim(model: str = "u2netp") -> dict:
    return {
        "schema_version": 1,
        "job_id": JOB_ID,
        "kind": "item_stage",
        "stage": "cutout",
        "lease_generation": 1,
        "lease_expires_at": "2026-09-26T10:00:00Z",
        "capability": "capability-token-for-this-job-only",
        "input": {"model": model, "original": {"width": 800, "height": 600}, "max_bytes": 20 * 1024 * 1024},
        "sources": {"original": {"url": f"http://store.test/original?{SIGNED}"}},
        "outputs": {
            "cutout": {"url": f"http://store.test/cutout?{SIGNED}", "content_type": "image/webp"},
            "thumbnail": {"url": f"http://store.test/thumbnail?{SIGNED}", "content_type": "image/webp"},
            "mask": {"url": f"http://store.test/mask?{SIGNED}", "content_type": "image/png"},
        },
    }


def stage_transport(source: bytes, calls: list[httpx.Request], claim: dict) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/jobs/claim":
            return httpx.Response(200, json={"data": claim})
        if request.url.path == "/original":
            return httpx.Response(200, content=source)
        if request.url.path in {"/cutout", "/thumbnail", "/mask"}:
            return httpx.Response(200)
        if request.url.path == f"/v1/jobs/{JOB_ID}/complete":
            return httpx.Response(200, json={"data": {"status": "applied"}})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


def test_an_item_stage_writes_three_signed_outputs_then_completes_with_their_checksums(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    claim = stage_claim()
    validate("worker_claim_response", claim)
    calls: list[httpx.Request] = []
    with httpx.Client(transport=stage_transport(encode(garment(), "WEBP"), calls, claim)) as client:
        assert (
            run_job({"job_id": JOB_ID, "claim_token": "b" * 64}, "http://internal.test", client)
            == "ready:applied"
        )
    paths = [call.url.path for call in calls]
    assert paths == [
        "/v1/jobs/claim",
        "/original",
        "/cutout",
        "/thumbnail",
        "/mask",
        f"/v1/jobs/{JOB_ID}/complete",
    ]
    assert [calls[i].headers["content-type"] for i in (2, 3, 4)] == ["image/webp", "image/webp", "image/png"]
    body = json.loads(calls[-1].content)
    validate("item_stage_complete_request", body)
    assert body["outputs"]["mask"]["width"] == 800 and body["outputs"]["cutout"]["width"] == 1024
    assert calls[-1].headers["authorization"] == "Bearer capability-token-for-this-job-only"
    assert SIGNED not in caplog.text


def test_an_item_stage_reports_no_foreground_and_uploads_nothing() -> None:
    calls: list[httpx.Request] = []
    blank = encode(Image.new("RGB", (800, 600), (200, 200, 200)), "WEBP")
    with httpx.Client(transport=stage_transport(blank, calls, stage_claim())) as client:
        assert (
            run_job({"job_id": JOB_ID, "claim_token": "b" * 64}, "http://internal.test", client)
            == "rejected:applied"
        )
    assert [call.url.path for call in calls] == ["/v1/jobs/claim", "/original", f"/v1/jobs/{JOB_ID}/complete"]
    assert json.loads(calls[-1].content)["failure_code"] == "NO_FOREGROUND"
