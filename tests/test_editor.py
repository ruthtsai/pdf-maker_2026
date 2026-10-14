from pathlib import Path

import pymupdf as fitz
import pytest

from core.editor import (
    EditRecipe,
    PageRef,
    RecipeError,
    Source,
    export_pdf,
    validate_recipe,
)
from core.file_utils import PdfEncryptedError
from tests.helpers import make_pdf, page_rotations, page_texts


@pytest.fixture
def src_a(tmp_path):
    return make_pdf(tmp_path / "a.pdf", ["A1", "A2", "A3", "A4"])


@pytest.fixture
def src_b(tmp_path):
    return make_pdf(tmp_path / "b.pdf", ["B1", "B2"])


def _export(tmp_path, refs, sources):
    return export_pdf(EditRecipe(pages=refs), sources, tmp_path / "out.pdf")


def test_identity_export_keeps_all_pages(tmp_path, src_a):
    refs = [PageRef("a", i) for i in range(4)]
    out = _export(tmp_path, refs, {"a": Source(src_a)})
    assert page_texts(out) == ["A1", "A2", "A3", "A4"]


def test_reorder_and_subset(tmp_path, src_a):
    refs = [PageRef("a", 3), PageRef("a", 0), PageRef("a", 2)]
    out = _export(tmp_path, refs, {"a": Source(src_a)})
    assert page_texts(out) == ["A4", "A1", "A3"]


def test_pages_from_two_sources_interleave(tmp_path, src_a, src_b):
    refs = [PageRef("a", 0), PageRef("b", 0), PageRef("a", 1), PageRef("b", 1)]
    out = _export(tmp_path, refs, {"a": Source(src_a), "b": Source(src_b)})
    assert page_texts(out) == ["A1", "B1", "A2", "B2"]


def test_rotation_adds_to_existing_rotation(tmp_path):
    src = make_pdf(tmp_path / "r.pdf", ["P1", "P2"])
    with fitz.open(src) as d:
        d[0].set_rotation(90)
        d.saveIncr()
    refs = [PageRef("r", 0, 90), PageRef("r", 1, 270)]
    out = _export(tmp_path, refs, {"r": Source(src)})
    assert page_rotations(out) == [180, 270]


def test_same_page_used_twice_rotates_independently(tmp_path, src_a):
    refs = [PageRef("a", 0, 90), PageRef("a", 0, 0)]
    out = _export(tmp_path, refs, {"a": Source(src_a)})
    assert page_texts(out) == ["A1", "A1"]
    assert page_rotations(out) == [90, 0]


def test_internal_link_follows_moved_page(tmp_path):
    src = tmp_path / "links.pdf"
    doc = fitz.open()
    for i in range(3):
        doc.new_page(width=200, height=200)
        doc[i].insert_text((20, 40), f"L{i + 1}")
    doc[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(10, 60, 100, 80), "page": 2})
    doc.save(str(src))
    doc.close()

    # reorder to [L3, L1, L2]; the link on L1 must now point at index 0 (L3)
    refs = [PageRef("l", 2), PageRef("l", 0), PageRef("l", 1)]
    out = _export(tmp_path, refs, {"l": Source(src)})
    with fitz.open(out) as d:
        links = [l for l in d[1].get_links() if l["kind"] == fitz.LINK_GOTO]
        assert links and links[0]["page"] == 0
        assert "L1" in d[1].get_text()


def test_external_link_preserved(tmp_path):
    src = tmp_path / "ext.pdf"
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    doc[0].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(10, 10, 100, 30), "uri": "https://example.com"})
    doc.save(str(src))
    doc.close()
    out = _export(tmp_path, [PageRef("e", 0)], {"e": Source(src)})
    with fitz.open(out) as d:
        assert any(l.get("uri") == "https://example.com" for l in d[0].get_links())


def test_source_files_are_not_modified(tmp_path, src_a):
    before = Path(src_a).read_bytes()
    _export(tmp_path, [PageRef("a", 1, 90)], {"a": Source(src_a)})
    assert Path(src_a).read_bytes() == before


def test_encrypted_source_needs_password(tmp_path, src_a):
    enc = tmp_path / "enc.pdf"
    with fitz.open(src_a) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    refs = [PageRef("e", 0)]
    with pytest.raises(PdfEncryptedError):
        _export(tmp_path, refs, {"e": Source(enc, "enc.pdf")})
    out = _export(tmp_path, refs, {"e": Source(enc, "enc.pdf", password="pw")})
    assert page_texts(out) == ["A1"]


def test_progress_and_cancel(tmp_path, src_a):
    calls = []
    export_pdf(
        EditRecipe(pages=[PageRef("a", 0)]),
        {"a": Source(src_a)},
        tmp_path / "o.pdf",
        progress_cb=lambda c, t, m: calls.append((c, t, m)),
    )
    assert calls and calls[-1][0] == calls[-1][1]
    with pytest.raises(InterruptedError):
        export_pdf(
            EditRecipe(pages=[PageRef("a", 0)]), {"a": Source(src_a)}, tmp_path / "o2.pdf", cancel_check=lambda: True
        )


@pytest.mark.parametrize(
    "pages, message",
    [
        ([], "沒有任何頁面"),
        ([PageRef("zzz", 0)], "來源檔案不存在"),
        ([PageRef("a", 9)], "不存在的來源頁碼"),
        ([PageRef("a", 0, 45)], "旋轉角度"),
    ],
)
def test_validate_recipe_rejects_bad_input(pages, message):
    with pytest.raises(RecipeError, match=message):
        validate_recipe(EditRecipe(pages=pages), {"a": 4})
