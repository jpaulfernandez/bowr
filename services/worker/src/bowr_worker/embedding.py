"""Item embeddings in a named, versioned vector space (ARCHITECTURE 6.4, 10.3).

The server names the space a job must use (model, revision, preprocessing);
the worker computes exactly that space or refuses with MODEL_UNAVAILABLE. It
never substitutes another model, so incompatible vectors are never produced.

Production space: FashionCLIP (512 dimensions), the image half of the pinned
upstream ONNX export. Its revision is the one in config/models.yaml, so a
changed pin is a different space. ``bowr_dev_embed`` is a deterministic
development stand-in built from color, layout and edge statistics. It is not
semantic, and the worker computes it only when ``BOWR_DEV_EMBEDDING=1`` (local
server and tests).
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
FASHION_CLIP = "fashion_clip"
# Composite on white, bicubic resize to 224 x 224, CLIP mean and deviation.
FASHION_CLIP_PREPROCESS = "cutout-on-white-224"
_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def fashion_clip_space() -> tuple[str, str, str] | None:
    entry = models.manifest().get(FASHION_CLIP)
    return (FASHION_CLIP, entry["revision"], FASHION_CLIP_PREPROCESS) if entry else None


def _unit(block: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(block))
    return block / norm if norm > 0 else block


def _rgba(cutout_bytes: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(cutout_bytes), formats=["WEBP", "PNG"]) as image:
            image.load()
            return image.convert("RGBA")
    except (OSError, SyntaxError, ValueError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error


def _fashion_clip_embed(cutout_bytes: bytes) -> np.ndarray:
    rgba = _rgba(cutout_bytes)
    if np.asarray(rgba.getchannel("A"), dtype=np.float64).sum() < 255:
        raise MediaRejected("NO_FOREGROUND")
    session = models.session(FASHION_CLIP)
    canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    canvas.alpha_composite(rgba)
    # Cutouts are square, so a direct resize keeps the aspect ratio.
    small = canvas.convert("RGB").resize((224, 224), Image.Resampling.BICUBIC)
    pixels = (np.asarray(small, dtype=np.float32) / 255.0 - _CLIP_MEAN) / _CLIP_STD
    # The export is the whole CLIP model, so it needs a text input. An empty
    # prompt (start and end tokens) does not affect the image vector.
    outputs = session.run(
        ["image_embeds"],
        {
            "pixel_values": pixels.transpose(2, 0, 1)[np.newaxis],
            "input_ids": np.array([[49406, 49407]], dtype=np.int64),
            "attention_mask": np.ones((1, 2), dtype=np.int64),
        },
    )
    return _unit(outputs[0][0].astype(np.float64))


def _dev_embed(cutout_bytes: bytes) -> np.ndarray:
    rgba = _rgba(cutout_bytes)
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
    space = (model, model_revision, preprocess_version)
    if space == DEV_SPACE and os.environ.get("BOWR_DEV_EMBEDDING") == "1":
        vector = _dev_embed(cutout_bytes)
    elif space == fashion_clip_space():
        vector = _fashion_clip_embed(cutout_bytes)
    else:
        raise models.ModelUnavailable(model)
    if vector.shape != (DIMENSION,) or not np.all(np.isfinite(vector)):
        raise MediaRejected("CORRUPT_IMAGE")
    return [round(float(value), 7) for value in vector]
