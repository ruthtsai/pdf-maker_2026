import zipfile

import pymupdf as fitz
import pytest

from core.file_utils import PdfEncryptedError
from core.splitter import SplitError, groups_by_ranges, groups_every, split_pdf
from tests.helpers import make_pdf, page_texts


def test_ranges_are_separated_by_semicolons():
    assert groups_by_ranges("1-3;4;5-8", 8) == [[0, 1, 2], [3], [4, 5, 6, 7]]


def test_a_range_group_may_list_several_pieces():
    assert groups_by_ranges(" 1,3 ; ;5-6 ", 6) == [[0, 2], [4, 5]]


@pytest.mark.parametrize(
    "spec, message",
    [
        ("", "請輸入"),
        (" ; ", "請輸入"),
        ("abc", "格式錯誤"),
        ("3-1", "格式錯誤"),
        ("1-3;4-9", "第 6 頁超出範圍（共 5 頁）"),
        ("1-3;9", "第 2 組「9」"),
        ("0", "格式錯誤"),
    ],
)
def test_bad_ranges_are_refused(spec, message):
    with pytest.raises(SplitError, match=message):
        groups_by_ranges(spec, 5)


def test_every_n_pages():
    assert groups_every(2, 5) == [[0, 1], [2, 3], [4]]
    assert groups_every(9, 3) == [[0, 1, 2]]
    with pytest.raises(SplitError):
        groups_every(0, 3)


def test_split_by_ranges_packs_parts_into_a_zip(tmp_path):
    pdf = make_pdf(tmp_path / "doc.pdf", ["P1", "P2", "P3", "P4"])
    result = split_pdf(pdf, groups_by_ranges("1-2;3;4", 4), tmp_path / "out", "doc")

    assert result.name == "doc.zip"
    with zipfile.ZipFile(result) as zf:
        assert zf.namelist() == ["doc_1-2.pdf", "doc_3.pdf", "doc_4.pdf"]
        zf.extractall(tmp_path / "x")
    assert page_texts(tmp_path / "x" / "doc_1-2.pdf") == ["P1", "P2"]
    assert page_texts(tmp_path / "x" / "doc_3.pdf") == ["P3"]
    assert not (tmp_path / "out" / "doc_3.pdf").exists()


def test_split_every_n_pages(tmp_path):
    pdf = make_pdf(tmp_path / "doc.pdf", ["P1", "P2", "P3", "P4", "P5"])
    result = split_pdf(pdf, groups_every(2, 5), tmp_path / "out", "doc")
    with zipfile.ZipFile(result) as zf:
        assert zf.namelist() == ["doc_1-2.pdf", "doc_3-4.pdf", "doc_5.pdf"]


def test_a_single_part_is_returned_as_a_pdf(tmp_path):
    pdf = make_pdf(tmp_path / "doc.pdf", ["P1", "P2", "P3"])
    result = split_pdf(pdf, groups_by_ranges("2-3", 3), tmp_path / "out", "doc")
    assert result.name == "doc_2-3.pdf"
    assert page_texts(result) == ["P2", "P3"]


def test_parts_with_the_same_pages_get_distinct_names(tmp_path):
    pdf = make_pdf(tmp_path / "doc.pdf", ["P1", "P2"])
    result = split_pdf(pdf, groups_by_ranges("1;1", 2), tmp_path / "out", "doc")
    with zipfile.ZipFile(result) as zf:
        assert zf.namelist() == ["doc_1.pdf", "doc_1_2.pdf"]


def test_an_encrypted_pdf_needs_its_password(tmp_path):
    plain = make_pdf(tmp_path / "p.pdf", ["S1", "S2"])
    enc = tmp_path / "enc.pdf"
    with fitz.open(plain) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")

    with pytest.raises(PdfEncryptedError):
        split_pdf(enc, [[0], [1]], tmp_path / "out", "enc")
    with pytest.raises(PdfEncryptedError):
        split_pdf(enc, [[0], [1]], tmp_path / "out", "enc", password="wrong")

    result = split_pdf(enc, [[1]], tmp_path / "out", "enc", password="pw")
    assert page_texts(result) == ["S2"]


def test_progress_and_cancel(tmp_path):
    pdf = make_pdf(tmp_path / "doc.pdf", ["P1", "P2"])
    calls = []
    split_pdf(pdf, [[0], [1]], tmp_path / "out", "doc", progress_cb=lambda c, t, m: calls.append((c, t)))
    assert calls[0] == (0, 2) and calls[-1] == (2, 2)

    with pytest.raises(InterruptedError):
        split_pdf(pdf, [[0], [1]], tmp_path / "out2", "doc", cancel_check=lambda: True)
