import pymupdf as fitz
import pytest

from core.compressor import LEVELS, CompressError, compress_pdf
from core.file_utils import PdfEncryptedError
from tests.helpers import image_sizes, make_image_pdf, make_pdf, page_texts


@pytest.fixture
def photo_pdf(tmp_path):
    return make_image_pdf(tmp_path / "photo.pdf", pages=2)


def test_the_three_levels_exist():
    assert set(LEVELS) == {"light", "standard", "strong"}


def test_standard_and_strong_downsample_images(photo_pdf, tmp_path):
    standard = compress_pdf(photo_pdf, tmp_path / "s.pdf", "standard")
    strong = compress_pdf(photo_pdf, tmp_path / "x.pdf", "strong")

    assert standard.compressed and strong.compressed
    assert standard.original_size == photo_pdf.stat().st_size
    assert standard.compressed_size == (tmp_path / "s.pdf").stat().st_size
    assert strong.compressed_size < standard.compressed_size < standard.original_size / 4
    assert all(w < 1200 for w, _ in image_sizes(tmp_path / "s.pdf"))
    assert sum(w for w, _ in image_sizes(tmp_path / "x.pdf")) < sum(w for w, _ in image_sizes(tmp_path / "s.pdf"))
    assert 0 < standard.saved_ratio < 1


def test_light_leaves_images_alone(photo_pdf, tmp_path):
    result = compress_pdf(photo_pdf, tmp_path / "l.pdf", "light")
    assert image_sizes(result.path) == image_sizes(photo_pdf)


def test_light_removes_unused_objects(tmp_path):
    src = make_pdf(tmp_path / "a.pdf", ["A1", "A2", "A3"])
    with fitz.open(src) as doc:  # leave dead objects behind with an incremental save
        doc.delete_page(1)
        doc.saveIncr()

    result = compress_pdf(src, tmp_path / "l.pdf", "light")
    assert result.compressed
    assert result.compressed_size < result.original_size
    assert page_texts(result.path) == ["A1", "A3"]


def already_compressed_pdf(tmp_path):
    src = make_pdf(tmp_path / "a.pdf", ["A1"])
    return compress_pdf(src, tmp_path / "once.pdf", "strong").path


def test_a_file_that_cannot_shrink_is_copied(tmp_path):
    src = already_compressed_pdf(tmp_path)
    result = compress_pdf(src, tmp_path / "out.pdf", "strong")

    assert not result.compressed
    assert result.compressed_size == result.original_size
    assert result.saved_ratio == 0
    assert (tmp_path / "out.pdf").read_bytes() == src.read_bytes()


def test_images_reach_the_target_resolution(tmp_path):
    src = make_image_pdf(tmp_path / "p.pdf")  # 1200 px across 3 inches: 400 DPI
    assert image_sizes(compress_pdf(src, tmp_path / "s.pdf", "standard").path) == [(450, 600)]
    assert image_sizes(compress_pdf(src, tmp_path / "x.pdf", "strong").path) == [(300, 400)]


def test_the_original_is_not_touched(photo_pdf, tmp_path):
    before = photo_pdf.read_bytes()
    compress_pdf(photo_pdf, tmp_path / "s.pdf", "strong")
    assert photo_pdf.read_bytes() == before


def test_an_encrypted_pdf_needs_its_password_and_stays_encrypted(tmp_path):
    plain = make_image_pdf(tmp_path / "p.pdf")
    enc = tmp_path / "enc.pdf"
    with fitz.open(plain) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")

    with pytest.raises(PdfEncryptedError):
        compress_pdf(enc, tmp_path / "o.pdf", "standard")
    with pytest.raises(PdfEncryptedError):
        compress_pdf(enc, tmp_path / "o.pdf", "standard", password="nope")

    result = compress_pdf(enc, tmp_path / "o.pdf", "standard", password="pw")
    assert result.compressed_size < result.original_size
    with fitz.open(result.path) as d:
        assert d.needs_pass
    assert image_sizes(result.path, "pw")[0][0] < 1200


def test_an_unknown_level_is_refused(photo_pdf, tmp_path):
    with pytest.raises(CompressError):
        compress_pdf(photo_pdf, tmp_path / "o.pdf", "extreme")


def test_progress_and_cancel(photo_pdf, tmp_path):
    calls = []
    compress_pdf(photo_pdf, tmp_path / "o.pdf", "standard", progress_cb=lambda c, t, m: calls.append((c, t)))
    assert calls[0][0] == 0 and calls[-1][0] == calls[-1][1]

    with pytest.raises(InterruptedError):
        compress_pdf(photo_pdf, tmp_path / "c.pdf", "standard", cancel_check=lambda: True)
    assert not (tmp_path / "c.pdf").exists()
