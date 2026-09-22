import zipfile

import pymupdf as fitz
import pypdf
import pytest
from PIL import Image

from core.converter import PageRangeError, convert_pdf, parse_page_range
from core.file_utils import PdfEncryptedError


def test_empty_range_returns_all_pages():
    pages, skipped = parse_page_range("", 5)
    assert pages == [0, 1, 2, 3, 4]
    assert skipped == []


def test_mixed_range():
    pages, skipped = parse_page_range("1-3,5", 10)
    assert pages == [0, 1, 2, 4]
    assert skipped == []


def test_out_of_range_is_skipped_not_fatal():
    pages, skipped = parse_page_range("1,8,20", 5)
    assert pages == [0]
    assert skipped == [8, 20]


def test_invalid_format_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("abc", 5)


def test_reversed_range_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("5-2", 10)


def test_all_out_of_range_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("99", 5)


def _make_pdf(path, page_count=3, width=200, height=300):
    doc = fitz.open()
    for _ in range(page_count):
        doc.new_page(width=width, height=height)
    doc.save(str(path))
    doc.close()


def _make_encrypted_pdf(path, password, page_count=1):
    src = path.parent / f"_plain_{path.name}"
    _make_pdf(src, page_count=page_count)
    reader = pypdf.PdfReader(str(src))
    writer = pypdf.PdfWriter()
    writer.append(reader)
    writer.encrypt(password)
    with open(path, "wb") as f:
        writer.write(f)


def test_convert_png_produces_expected_files(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=3)
    out_dir = tmp_path / "out"

    result = convert_pdf(pdf_path, [0, 2], out_dir, "doc", fmt="png", dpi=100)

    assert isinstance(result, list)
    names = sorted(p.name for p in result)
    assert names == ["doc_1.png", "doc_3.png"]
    for p in result:
        assert p.exists()
        with Image.open(p) as img:
            assert img.format == "PNG"


def test_convert_jpg_quality(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=1, width=200, height=300)
    out_dir = tmp_path / "out"

    result = convert_pdf(pdf_path, [0], out_dir, "doc", fmt="jpg", dpi=100, jpg_quality=40)

    assert len(result) == 1
    with Image.open(result[0]) as img:
        assert img.format == "JPEG"
        assert img.mode == "RGB"


def test_convert_dpi_scales_pixel_size(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=1, width=200, height=300)

    low = convert_pdf(pdf_path, [0], tmp_path / "low", "doc", fmt="png", dpi=72)
    high = convert_pdf(pdf_path, [0], tmp_path / "high", "doc", fmt="png", dpi=144)

    with Image.open(low[0]) as img_low, Image.open(high[0]) as img_high:
        assert img_high.width == pytest.approx(img_low.width * 2, rel=0.02)
        assert img_high.height == pytest.approx(img_low.height * 2, rel=0.02)


def test_convert_pack_zip_bundles_and_removes_loose_files(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=2)
    out_dir = tmp_path / "out"

    result = convert_pdf(pdf_path, [0, 1], out_dir, "doc", fmt="png", dpi=72, pack_zip=True)

    assert result.suffix == ".zip"
    assert result.exists()
    with zipfile.ZipFile(result) as zf:
        assert sorted(zf.namelist()) == ["doc_1.png", "doc_2.png"]
    assert not (out_dir / "doc_1.png").exists()
    assert not (out_dir / "doc_2.png").exists()


def test_convert_encrypted_pdf_requires_password(tmp_path):
    pdf_path = tmp_path / "enc.pdf"
    _make_encrypted_pdf(pdf_path, "secret123")

    with pytest.raises(PdfEncryptedError):
        convert_pdf(pdf_path, [0], tmp_path / "out", "doc")

    result = convert_pdf(pdf_path, [0], tmp_path / "out2", "doc", password="secret123")
    assert len(result) == 1


def test_convert_progress_callback_invoked(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=2)

    calls = []
    convert_pdf(
        pdf_path,
        [0, 1],
        tmp_path / "out",
        "doc",
        progress_cb=lambda cur, total, msg: calls.append((cur, total, msg)),
    )
    assert calls[0] == (0, 2, "第 1 頁")
    assert calls[-1] == (2, 2, "完成")


def test_convert_cancel_raises_interrupted(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=2)

    with pytest.raises(InterruptedError):
        convert_pdf(pdf_path, [0, 1], tmp_path / "out", "doc", cancel_check=lambda: True)
