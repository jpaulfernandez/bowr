"""Item embeddings in a named, versioned vector space (ARCHITECTURE 6.4, 10.3).

The server names the space a job must use (model, revision, preprocessing);
the worker computes exactly that space or refuses with MODEL_UNAVAILABLE. It
never substitutes another model, so incompatible vectors are never produced.

Production space: FashionCLIP (512 dimensions), enabled only after its weights
are pinned with a checksum and its license verified (P1.07-T2). The only space
implemented here is ``bowr_dev_embed``: a deterministic development stand-in
built from color, layout and edge statistics. It is not semantic, and the
worker computes it only when ``BOWR_DEV_EMBEDDING=1`` (local server and tests).
"""

from __future__ import annotations

import io
import os

import numpy as np
from PIL import Image

from . import models
from .media import MediaRejected

DIMENSION = 512
DEV_SPACE = ("bowr_dev_embed", "v1", "cutout-on-grey-64")


def _unit(block: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(block))
    return block / norm if norm > 0 else block


def _dev_embed(cutout_bytes: bytes) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(cutout_bytes), formats=["WEBP", "PNG"]) as image:
            image.load()
            rgba = image.convert("RGBA")
    except (OSError, SyntaxError, ValueError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error
    # Preprocessing "cutout-on-grey-64": composite on neutral grey, 64 x 64.
    canvas = Image.new("RGBA", rgba.size, (128, 128, 128, 255))
    canvas.alpha_composite(rgba)
    small = canvas.convert("RGB").resize((64, 64), Image.Resampling.LANCZOS)
    alpha = (
        np.asarray(rgba.getchannel("A").resize((64, 64), Image.Resampling.BILINEAR), dtype=np.float64) / 255.0
    )
    pixels = np.asarray(small, dtype=np.float64) / 255.0
    if alpha.sum() < 1:
        raise MediaRejected("NO_FOREGROUND")

    # 64: color histogram (4 x 4 x 4 bins) weighted by foreground.
    bins = np.minimum((pixels * 4).astype(int), 3)
    index = bins[:, :, 0] * 16 + bins[:, :, 1] * 4 + bins[:, :, 2]
    color = np.bincount(index.ravel(), weights=alpha.ravel(), minlength=64)
    # 256: 16 x 16 luminance layout, zero-mean.
    gray = pixels @ np.array([0.299, 0.587, 0.114])
    layout = gray.reshape(16, 4, 16, 4).mean(axis=(1, 3)).ravel()
    layout = layout - layout.mean()
    # 128: gradient orientation histograms, 4 x 4 cells x 8 bins.
    gy, gx = np.gradient(gray)
    magnitude = np.hypot(gx, gy)
    orientation = ((np.arctan2(gy, gx) + np.pi) / (2 * np.pi) * 8).astype(int) % 8
    edges = np.zeros((4, 4, 8))
    for cy in range(4):
        for cx in range(4):
            cell = (slice(cy * 16, cy * 16 + 16), slice(cx * 16, cx * 16 + 16))
            edges[cy, cx] = np.bincount(
                orientation[cell].ravel(), weights=magnitude[cell].ravel(), minlength=8
            )
    # 64: 8 x 8 silhouette.
    silhouette = alpha.reshape(8, 8, 8, 8).mean(axis=(1, 3)).ravel()

    vector = np.concatenate([_unit(color), _unit(layout), _unit(edges.ravel()), _unit(silhouette)])
    return _unit(vector)


def embed(cutout_bytes: bytes, model: str, model_revision: str, preprocess_version: str) -> list[float]:
    """A normalized 512-value vector in exactly the requested space."""
    if (model, model_revision, preprocess_version) == DEV_SPACE and os.environ.get(
        "BOWR_DEV_EMBEDDING"
    ) == "1":
        vector = _dev_embed(cutout_bytes)
    else:
        raise models.ModelUnavailable(model)
    if vector.shape != (DIMENSION,) or not np.all(np.isfinite(vector)):
        raise MediaRejected("CORRUPT_IMAGE")
    return [round(float(value), 7) for value in vector]
