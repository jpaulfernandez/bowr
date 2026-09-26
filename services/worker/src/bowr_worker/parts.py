"""Grouped photos (ARCHITECTURE section 8.2): proposed part rectangles and crops.

Proposals are only suggestions for the member to confirm, edit or discard; no
piece is created from them. Boxes are normalized (0..1) in the sanitized,
already-oriented original, as ``{"x", "y", "w", "h"}``.
"""

from __future__ import annotations

import io
import math
from collections import deque

import numpy as np
from PIL import Image

from . import models
from .cutout import FOREGROUND, Rendition, _encode, predict_mask
from .media import MediaRejected

MAX_PARTS = 20
# The pinned default cutout model also separates the pieces of a grouped photo.
PROPOSAL_MODEL = "isnet_general_use"
# Proposals are found on a small grid; the member refines them.
GRID_EDGE = 128
# A region smaller than this share of the photo is noise, not a piece.
MIN_REGION_SHARE = 0.002
PADDING = 0.03
MIN_CROP_EDGE = 32


def _components(foreground: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """8-connected regions as (area, top, left, bottom, right), largest first."""
    height, width = foreground.shape
    seen = np.zeros_like(foreground, dtype=bool)
    regions: list[tuple[int, int, int, int, int]] = []
    for start_y, start_x in zip(*np.nonzero(foreground), strict=True):
        if seen[start_y, start_x]:
            continue
        seen[start_y, start_x] = True
        queue = deque([(int(start_y), int(start_x))])
        area, top, left, bottom, right = 0, height, width, 0, 0
        while queue:
            y, x = queue.popleft()
            area += 1
            top, left, bottom, right = min(top, y), min(left, x), max(bottom, y), max(right, x)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and foreground[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
        regions.append((area, top, left, bottom + 1, right + 1))
    return sorted(regions, reverse=True)


def propose_parts(image: Image.Image, model: str) -> list[dict[str, float]]:
    """Separate foreground regions of a grouped photo, as padded normalized boxes.

    An unavailable model yields no proposals; the member draws rectangles instead.
    """
    try:
        probability = predict_mask(image, model)
    except models.ModelUnavailable:
        return []
    grid = Image.fromarray(probability, mode="F")
    grid.thumbnail((GRID_EDGE, GRID_EDGE), Image.Resampling.BILINEAR)
    foreground = np.asarray(grid) >= FOREGROUND
    rows, cols = foreground.shape
    proposals: list[dict[str, float]] = []
    for area, top, left, bottom, right in _components(foreground)[:MAX_PARTS]:
        if area < MIN_REGION_SHARE * rows * cols:
            break
        x0 = max(0.0, left / cols - PADDING)
        y0 = max(0.0, top / rows - PADDING)
        x1 = min(1.0, right / cols + PADDING)
        y1 = min(1.0, bottom / rows + PADDING)
        proposals.append(
            {"x": round(x0, 4), "y": round(y0, 4), "w": round(x1 - x0, 4), "h": round(y1 - y0, 4)}
        )
    return proposals


def crop(source_bytes: bytes, box: dict[str, float]) -> Rendition:
    """One confirmed part as its own sanitized original (WebP)."""
    try:
        with Image.open(io.BytesIO(source_bytes), formats=["WEBP"]) as image:
            image.load()
            source = image.convert("RGB")
    except (OSError, SyntaxError, ValueError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error
    left = max(0, math.floor(box["x"] * source.width))
    top = max(0, math.floor(box["y"] * source.height))
    right = min(source.width, math.ceil((box["x"] + box["w"]) * source.width))
    bottom = min(source.height, math.ceil((box["y"] + box["h"]) * source.height))
    if right - left < MIN_CROP_EDGE or bottom - top < MIN_CROP_EDGE:
        raise MediaRejected("CORRUPT_IMAGE")
    part = source.crop((left, top, right, bottom))
    return Rendition(_encode(part, "WEBP"), part.width, part.height, "image/webp")
