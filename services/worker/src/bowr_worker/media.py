"""Decode, bound and normalize an uploaded photo (ARCHITECTURE section 8.2).

The output is a privacy-sanitized WebP: orientation applied, converted to sRGB,
no EXIF/GPS/XMP/ICC metadata, longest edge at most ``max_edge``. Bytes that are
not an allowed, single-frame, correctly declared image are rejected with a
stable failure code and never produce an output.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

import pillow_heif
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

pillow_heif.register_heif_opener()

# Pillow format name -> declared content types that may carry it.
ALLOWED_FORMATS: dict[str, frozenset[str]] = {
    "JPEG": frozenset({"image/jpeg"}),
    "PNG": frozenset({"image/png"}),
    "WEBP": frozenset({"image/webp"}),
    "HEIF": frozenset({"image/heic", "image/heif"}),
}
WEBP_QUALITY = 85


class MediaRejected(Exception):
    """A terminal, user-correctable problem with the uploaded file."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class NormalizedImage:
    data: bytes
    width: int
    height: int
    sha256: str


def normalize(
    data: bytes,
    *,
    declared_content_type: str,
    rotation: int = 0,
    max_bytes: int,
    max_pixels: int,
    max_edge: int,
) -> NormalizedImage:
    if len(data) > max_bytes:
        raise MediaRejected("FILE_TOO_LARGE")
    try:
        # Only allowlisted decoders run; SVG, GIF, TIFF and others are never parsed.
        with Image.open(io.BytesIO(data), formats=list(ALLOWED_FORMATS)) as image:
            if declared_content_type not in ALLOWED_FORMATS.get(image.format or "", frozenset()):
                raise MediaRejected("MEDIA_TYPE_MISMATCH")
            width, height = image.size
            # Checked from the header, before any pixel data is decoded.
            if width * height > max_pixels:
                raise MediaRejected("TOO_MANY_PIXELS")
            if getattr(image, "n_frames", 1) != 1 or getattr(image, "is_animated", False):
                raise MediaRejected("ANIMATED_IMAGE")
            image.load()
            icc_profile = image.info.get("icc_profile")
            oriented = ImageOps.exif_transpose(image)
    except MediaRejected:
        raise
    except UnidentifiedImageError as error:
        raise MediaRejected("UNSUPPORTED_MEDIA") from error
    except Image.DecompressionBombError as error:
        raise MediaRejected("TOO_MANY_PIXELS") from error
    except (OSError, SyntaxError, ValueError, EOFError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error

    converted = _to_srgb(oriented, icc_profile)
    if rotation:
        converted = converted.rotate(-rotation, expand=True)
    if max(converted.size) > max_edge:
        converted.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)

    converted.info = {}
    buffer = io.BytesIO()
    converted.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=4)
    output = buffer.getvalue()
    return NormalizedImage(
        data=output,
        width=converted.width,
        height=converted.height,
        sha256=hashlib.sha256(output).hexdigest(),
    )


def _to_srgb(image: Image.Image, icc_profile: bytes | None) -> Image.Image:
    has_alpha = image.mode in {"RGBA", "LA", "PA"} or (image.mode == "P" and "transparency" in image.info)
    target = "RGBA" if has_alpha else "RGB"
    if icc_profile:
        try:
            source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
            srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
            if image.mode not in {"RGB", "RGBA", "CMYK", "L"}:
                image = image.convert(target)
            return ImageCms.profileToProfile(image, source, srgb, outputMode=target)
        except (ImageCms.PyCMSError, OSError, ValueError):
            # An unreadable profile is ignored and the pixels are treated as sRGB.
            pass
    return image.convert(target)
