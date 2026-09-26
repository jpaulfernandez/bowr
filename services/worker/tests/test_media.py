"""P0.03-A1 worker cases: decode bounds, orientation, sRGB and metadata removal."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from bowr_worker.media import MediaRejected, normalize

from .conftest import (
    animated,
    encode,
    jpeg_with_orientation_and_gps,
    two_tone,
    webp_chunks,
    with_srgb_profile,
)

MiB = 1024 * 1024
LIMITS = {"max_bytes": 20 * MiB, "max_pixels": 40_000_000, "max_edge": 1024}


def run(data: bytes, declared: str, **overrides: int):
    return normalize(data, declared_content_type=declared, **{**LIMITS, **overrides})


def decoded(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


@pytest.mark.parametrize(
    ("fmt", "declared"),
    [
        ("JPEG", "image/jpeg"),
        ("PNG", "image/png"),
        ("WEBP", "image/webp"),
        ("HEIF", "image/heic"),
        ("HEIF", "image/heif"),
    ],
)
def test_valid_formats_produce_sanitized_webp(fmt: str, declared: str) -> None:
    result = run(encode(two_tone(), fmt), declared)
    assert (result.width, result.height) == (400, 200)
    assert set(webp_chunks(result.data)).isdisjoint({"EXIF", "XMP ", "ICCP"})
    output = decoded(result.data)
    assert output.format == "WEBP"
    assert "exif" not in output.info and "icc_profile" not in output.info


def test_exif_orientation_is_applied_and_gps_removed() -> None:
    result = run(jpeg_with_orientation_and_gps(orientation=6), "image/jpeg")
    # Orientation 6 means "rotate 90 degrees clockwise to display".
    assert (result.width, result.height) == (200, 400)
    output = decoded(result.data).convert("RGB")
    top, bottom = output.getpixel((100, 10)), output.getpixel((100, 390))
    assert top[0] > 200 and top[2] < 60, "red half is on top after rotation"
    assert bottom[2] > 200 and bottom[0] < 60, "blue half is at the bottom"
    assert b"FixtureCam" not in result.data
    assert "EXIF" not in webp_chunks(result.data)


def test_user_rotation_is_applied_after_orientation() -> None:
    result = run(encode(two_tone(), "PNG"), "image/png", rotation=90)
    assert (result.width, result.height) == (200, 400)


def test_srgb_profile_is_converted_and_not_embedded() -> None:
    result = run(with_srgb_profile(two_tone(), "PNG"), "image/png")
    assert "ICCP" not in webp_chunks(result.data)
    red = decoded(result.data).convert("RGB").getpixel((10, 10))
    assert red[0] > 240 and red[1] < 20 and red[2] < 20


def test_cmyk_jpeg_becomes_rgb() -> None:
    cmyk = Image.new("CMYK", (64, 64), (0, 255, 255, 0))
    output = decoded(run(encode(cmyk, "JPEG"), "image/jpeg").data)
    assert output.mode in {"RGB", "RGBA"}


def test_transparency_is_preserved() -> None:
    image = two_tone(mode="RGBA")
    image.paste((0, 0, 0, 0), (0, 0, 50, 50))
    output = decoded(run(encode(image, "PNG"), "image/png").data)
    assert output.mode == "RGBA"
    assert output.getpixel((10, 10))[3] == 0


def test_longest_edge_is_bounded_and_small_images_are_not_upscaled() -> None:
    large = encode(two_tone(3000, 1500), "PNG")
    assert (lambda r: (r.width, r.height))(run(large, "image/png")) == (1024, 512)
    assert (lambda r: (r.width, r.height))(run(large, "image/png", max_edge=2048)) == (2048, 1024)
    assert (lambda r: (r.width, r.height))(run(encode(two_tone(300, 100), "PNG"), "image/png")) == (300, 100)


def test_output_is_deterministic_for_the_same_input() -> None:
    data = encode(two_tone(), "PNG")
    assert run(data, "image/png").sha256 == run(data, "image/png").sha256


@pytest.mark.parametrize(
    ("data", "declared", "code"),
    [
        (encode(two_tone(), "PNG"), "image/jpeg", "MEDIA_TYPE_MISMATCH"),
        (encode(two_tone(), "JPEG"), "image/heic", "MEDIA_TYPE_MISMATCH"),
        (b"<html><script>alert(1)</script></html>", "image/jpeg", "UNSUPPORTED_MEDIA"),
        (
            b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
            "image/png",
            "UNSUPPORTED_MEDIA",
        ),
        (encode(two_tone(), "GIF"), "image/png", "UNSUPPORTED_MEDIA"),
        (encode(two_tone(), "TIFF"), "image/jpeg", "UNSUPPORTED_MEDIA"),
        (animated("WEBP"), "image/webp", "ANIMATED_IMAGE"),
        (animated("PNG"), "image/png", "ANIMATED_IMAGE"),
        (b"", "image/jpeg", "UNSUPPORTED_MEDIA"),
    ],
    ids=["png-as-jpeg", "jpeg-as-heic", "html", "svg", "gif", "tiff", "animated-webp", "apng", "empty"],
)
def test_rejections(data: bytes, declared: str, code: str) -> None:
    with pytest.raises(MediaRejected) as rejected:
        run(data, declared)
    assert rejected.value.code == code


def test_truncated_jpeg_is_corrupt() -> None:
    data = encode(two_tone(1200, 900), "JPEG", quality=95)
    with pytest.raises(MediaRejected) as rejected:
        run(data[: len(data) // 2], "image/jpeg")
    assert rejected.value.code == "CORRUPT_IMAGE"


def test_byte_limit_boundary() -> None:
    data = encode(two_tone(), "PNG")
    assert run(data, "image/png", max_bytes=len(data)).width == 400
    with pytest.raises(MediaRejected) as rejected:
        run(data, "image/png", max_bytes=len(data) - 1)
    assert rejected.value.code == "FILE_TOO_LARGE"


def test_pixel_limit_boundary_at_40_megapixels() -> None:
    at_limit = encode(Image.new("RGB", (8000, 5000), (20, 30, 40)), "PNG")
    result = run(at_limit, "image/png")
    assert (result.width, result.height) == (1024, 640)
    over_limit = encode(Image.new("RGB", (8001, 5000), (20, 30, 40)), "PNG")
    with pytest.raises(MediaRejected) as rejected:
        run(over_limit, "image/png")
    assert rejected.value.code == "TOO_MANY_PIXELS"


def test_heic_decoder_is_pinned() -> None:
    import pillow_heif

    assert pillow_heif.__version__ == "1.8.0"
    assert "libde265" in str(pillow_heif.libheif_info()["decoders"])
