"""Background removal (ARCHITECTURE section 8.2, step 5).

From the sanitized original: an editable mask at the original's size, a
transparent 1024 px square cutout with a safe margin, and a 256 px thumbnail.
The UI supplies the neutral background; no shadow is drawn.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from . import models
from .media import MediaRejected

CUTOUT_EDGE = 1024
THUMBNAIL_EDGE = 256
# DESIGN 8.5: roughly a 10-12% safe margin around the garment.
MARGIN = 0.1
# A mask pixel counts as foreground above this probability.
FOREGROUND = 0.5
# Less foreground than this is treated as "no garment found", not a cutout.
MIN_FOREGROUND_RATIO = 0.005

IMAGENET = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))
# name -> (square input size, per-channel mean, per-channel std)
SPECS: dict[str, tuple[int, tuple[float, ...], tuple[float, ...]]] = {
    "isnet_general_use": (1024, (0.5, 0.5, 0.5), (1.0, 1.0, 1.0)),
    "u2netp": (320, *IMAGENET),
}


@dataclass(frozen=True)
class Rendition:
    data: bytes
    width: int
    height: int
    content_type: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    def describe(self) -> dict[str, object]:
        return {
            "width": self.width,
            "height": self.height,
            "byte_size": len(self.data),
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class CutoutResult:
    cutout: Rendition
    thumbnail: Rendition
    mask: Rendition
    foreground_ratio: float


def predict_mask(image: Image.Image, model: str) -> np.ndarray:
    """Foreground probability per pixel at the image's size (float32, 0..1)."""
    if model not in SPECS:
        raise models.ModelUnavailable(model)
    size, mean, std = SPECS[model]
    session = models.session(model)
    pixels = (
        np.asarray(image.convert("RGB").resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
        / 255.0
    )
    tensor = ((pixels - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)).transpose(
        2, 0, 1
    )[None]
    output = session.run(None, {session.get_inputs()[0].name: tensor.astype(np.float32)})[0][0, 0]
    probability = Image.fromarray(np.clip(output, 0.0, 1.0).astype(np.float32), mode="F")
    return np.asarray(probability.resize(image.size, Image.Resampling.BILINEAR), dtype=np.float32)


def _encode(image: Image.Image, fmt: str) -> bytes:
    buffer = io.BytesIO()
    if fmt == "WEBP":
        image.save(buffer, format="WEBP", quality=90, method=4)
    else:
        image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def render(original: Image.Image, mask: np.ndarray) -> CutoutResult:
    """Composes the renditions from an original and its 8-bit mask (0..255)."""
    if mask.shape != (original.height, original.width):
        raise MediaRejected("CORRUPT_IMAGE")
    foreground = mask >= int(FOREGROUND * 255)
    ratio = float(foreground.mean())
    if ratio < MIN_FOREGROUND_RATIO:
        raise MediaRejected("NO_FOREGROUND")

    rows = np.flatnonzero(foreground.any(axis=1))
    cols = np.flatnonzero(foreground.any(axis=0))
    box = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
    rgba = original.convert("RGB").convert("RGBA")
    rgba.putalpha(Image.fromarray(mask.astype(np.uint8), mode="L"))
    piece = rgba.crop(box)

    inner = CUTOUT_EDGE * (1 - 2 * MARGIN)
    scale = min(inner / piece.width, inner / piece.height)
    fitted = piece.resize(
        (max(1, round(piece.width * scale)), max(1, round(piece.height * scale))), Image.Resampling.LANCZOS
    )
    canvas = Image.new("RGBA", (CUTOUT_EDGE, CUTOUT_EDGE), (0, 0, 0, 0))
    canvas.paste(fitted, ((CUTOUT_EDGE - fitted.width) // 2, (CUTOUT_EDGE - fitted.height) // 2), fitted)
    thumbnail = canvas.resize((THUMBNAIL_EDGE, THUMBNAIL_EDGE), Image.Resampling.LANCZOS)

    return CutoutResult(
        cutout=Rendition(_encode(canvas, "WEBP"), CUTOUT_EDGE, CUTOUT_EDGE, "image/webp"),
        thumbnail=Rendition(_encode(thumbnail, "WEBP"), THUMBNAIL_EDGE, THUMBNAIL_EDGE, "image/webp"),
        mask=Rendition(
            _encode(Image.fromarray(mask.astype(np.uint8), mode="L"), "PNG"),
            original.width,
            original.height,
            "image/png",
        ),
        foreground_ratio=round(ratio, 4),
    )


def cutout(original_bytes: bytes, model: str) -> CutoutResult:
    """Runs a pinned model on a sanitized original and renders the results."""
    try:
        with Image.open(io.BytesIO(original_bytes), formats=["WEBP"]) as image:
            image.load()
            original = image.convert("RGB")
    except (OSError, SyntaxError, ValueError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error
    probability = predict_mask(original, model)
    return render(original, np.round(probability * 255).astype(np.uint8))
