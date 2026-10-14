import pymupdf as fitz
import pytest

from core.editor import (
    EditRecipe,
    LabelRule,
    NumberStamp,
    PageRef,
    RecipeError,
    Source,
    export_pdf,
    format_page_number,
    render_preview,
    to_roman,
    validate_recipe,
)
from tests.helpers import make_pdf


def _build(tmp_path, n=5, rot=0, stamp=None, labels=None, size=(300, 400), crop=None):
    src = make_pdf(tmp_path / "s.pdf", [f"P{i + 1}" for i in range(n)], size=size)
    if crop:
        with fitz.open(src) as d:
            for p in d:
                p.set_cropbox(fitz.Rect(*crop))
            d.saveIncr()
    recipe = EditRecipe(
        pages=[PageRef("s", i, rot) for i in range(n)],
        labels=labels or [],
        number_stamp=stamp,
    )
    out = export_pdf(recipe, {"s": Source(src)}, tmp_path / "o.pdf")
    return fitz.open(out)


def _stamp_line(page, needle):
    """(direction, bbox) of the text line containing `needle`, in the page's visual frame."""
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            if needle in "".join(s["text"] for s in line["spans"]):
                return line["dir"], fitz.Rect(line["bbox"])
    raise AssertionError(f"{needle!r} not found on page")


@pytest.mark.parametrize(
    "n, expected",
    [(1, "I"), (4, "IV"), (9, "IX"), (14, "XIV"), (40, "XL"), (1994, "MCMXCIV")],
)
def test_to_roman(n, expected):
    assert to_roman(n) == expected


def test_format_page_number():
    assert format_page_number("number", 7, 20) == "7"
    assert format_page_number("roman", 3, 20) == "iii"
    assert format_page_number("roman_upper", 3, 20) == "III"
    assert format_page_number("of", 3, 20) == "第 3 頁／共 20 頁"


def test_stamp_text_content_and_start_page(tmp_path):
    stamp = NumberStamp(fmt="of", start_page=2, start_number=1)
    d = _build(tmp_path, n=4, stamp=stamp)
    assert "第" not in d[0].get_text()                    # before start_page: unnumbered
    assert "第 1 頁／共 3 頁" in d[1].get_text()
    assert "第 3 頁／共 3 頁" in d[3].get_text()


def test_stamp_start_number_offset(tmp_path):
    d = _build(tmp_path, n=3, stamp=NumberStamp(fmt="number", start_page=1, start_number=10))
    assert [p.get_text().split()[-1] for p in d] == ["10", "11", "12"]


@pytest.mark.parametrize("v_pos", ["top", "bottom"])
@pytest.mark.parametrize("h_pos", ["left", "center", "right"])
def test_stamp_position_in_visual_frame(tmp_path, v_pos, h_pos):
    d = _build(tmp_path, n=1, stamp=NumberStamp(fmt="number", start_number=7, v_pos=v_pos, h_pos=h_pos, font_size=12))
    page = d[0]
    _, bbox = _stamp_line(page, "7")
    cx = (bbox.x0 + bbox.x1) / 2
    cy = (bbox.y0 + bbox.y1) / 2
    third = page.rect.width / 3
    if h_pos == "left":
        assert cx < third
    elif h_pos == "right":
        assert cx > 2 * third
    else:
        assert third < cx < 2 * third
    assert (cy < page.rect.height / 4) if v_pos == "top" else (cy > 3 * page.rect.height / 4)


def _render_gray(page):
    return page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csGRAY, alpha=False)


def _blank_pdf(path, size):
    doc = fitz.open()
    doc.new_page(width=size[0], height=size[1])
    doc.save(str(path))
    doc.close()
    return path


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
@pytest.mark.parametrize("crop", [None, (20, 30, 260, 350)])
def test_stamp_looks_identical_to_stamping_an_upright_page(tmp_path, rot, crop):
    """Whatever the page rotation / crop box, the stamp must look exactly like it would on an
    upright page of the same visual size (same position, readable left-to-right)."""
    stamp = NumberStamp(fmt="of", font_size=12, start_number=3)

    blank = _blank_pdf(tmp_path / "blank.pdf", (300, 400))
    with fitz.open(blank) as d:
        if crop:
            d[0].set_cropbox(fitz.Rect(*crop))
        d.saveIncr()
    got = export_pdf(
        EditRecipe(pages=[PageRef("b", 0, rot)], number_stamp=stamp), {"b": Source(blank)}, tmp_path / "got.pdf"
    )

    with fitz.open(got) as g:
        vw, vh = g[0].rect.width, g[0].rect.height
        assert g[0].rotation == rot
        got_pix = _render_gray(g[0])

    upright = _blank_pdf(tmp_path / "upright.pdf", (vw, vh))
    ref = export_pdf(
        EditRecipe(pages=[PageRef("u", 0)], number_stamp=stamp), {"u": Source(upright)}, tmp_path / "ref.pdf"
    )
    with fitz.open(ref) as r:
        ref_pix = _render_gray(r[0])

    assert (got_pix.width, got_pix.height) == (ref_pix.width, ref_pix.height)
    ink_ref = sum(1 for v in ref_pix.samples if v < 128)
    assert ink_ref > 50                                   # the reference really has a stamp
    differing = sum(1 for a, b in zip(got_pix.samples, ref_pix.samples) if abs(a - b) > 80)
    assert differing < 20


def test_stamping_keeps_page_geometry_and_links(tmp_path):
    src = tmp_path / "l.pdf"
    doc = fitz.open()
    doc.new_page(width=300, height=400)
    doc[0].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(10, 10, 100, 30), "uri": "https://example.com"})
    doc[0].set_cropbox(fitz.Rect(10, 20, 250, 360))
    doc.save(str(src))
    doc.close()
    recipe = EditRecipe(pages=[PageRef("l", 0, 90)], number_stamp=NumberStamp())
    out = export_pdf(recipe, {"l": Source(src)}, tmp_path / "o.pdf")
    with fitz.open(out) as d:
        assert d[0].rotation == 90
        assert tuple(d[0].cropbox) == (10, 20, 250, 360)
        assert any(l.get("uri") == "https://example.com" for l in d[0].get_links())


def test_page_labels_roman_front_matter_then_decimal(tmp_path):
    labels = [LabelRule(0, "r", "", 1), LabelRule(3, "D", "", 1)]
    d = _build(tmp_path, n=6, labels=labels)
    assert [d[i].get_label() for i in range(6)] == ["i", "ii", "iii", "1", "2", "3"]


def test_page_labels_prefix_and_first_number(tmp_path):
    # pypdf is used to read this back: PyMuPDF's get_label() doesn't decode UTF-16 prefixes,
    # while real viewers do.
    import pypdf

    tricky = "(a)" + chr(92)  # parentheses and a backslash must be escaped in the PDF string
    d = _build(tmp_path, n=3, labels=[LabelRule(1, "D", "附錄-", 5), LabelRule(2, "D", tricky, 1)])
    d.close()
    reader = pypdf.PdfReader(str(tmp_path / "o.pdf"))
    assert reader.page_labels == ["1", "附錄-5", tricky + "1"]


def test_preview_shows_stamp_for_right_global_index(tmp_path):
    src = make_pdf(tmp_path / "s.pdf", ["P1", "P2", "P3", "P4"])
    recipe = EditRecipe(
        pages=[PageRef("s", i) for i in range(4)],
        number_stamp=NumberStamp(fmt="of", start_page=2),
    )
    png = render_preview(recipe, {"s": Source(src)}, 2, 500)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pix = fitz.Pixmap(png)
    assert pix.width == 500
    # same page rendered with a stamp must differ from the unstamped render
    plain = render_preview(EditRecipe(pages=recipe.pages), {"s": Source(src)}, 2, 500)
    assert plain != png


@pytest.mark.parametrize(
    "kwargs, message",
    [
        (dict(number_stamp=NumberStamp(fmt="weird")), "位置或格式無效"),
        (dict(number_stamp=NumberStamp(start_page=99)), "起始頁超出範圍"),
        (dict(number_stamp=NumberStamp(font_size=1)), "字型大小"),
        (dict(labels=[LabelRule(0, "X")]), "樣式無效"),
        (dict(labels=[LabelRule(50, "D")]), "起始頁超出範圍"),
        (dict(labels=[LabelRule(0, "D", "", 0)]), "起始號碼"),
    ],
)
def test_validation(kwargs, message):
    recipe = EditRecipe(pages=[PageRef("a", 0), PageRef("a", 1)], **kwargs)
    with pytest.raises(RecipeError, match=message):
        validate_recipe(recipe, {"a": 2})


def test_cjk_font_is_embedded_once_not_per_page(tmp_path):
    d = _build(tmp_path, n=30, stamp=NumberStamp(fmt="of"))
    d.close()
    size_kb = (tmp_path / "o.pdf").stat().st_size / 1024
    assert size_kb < 700, f"CJK font appears to be embedded repeatedly ({size_kb:.0f} KB)"
    with fitz.open(tmp_path / "o.pdf") as out:
        assert "第 30 頁／共 30 頁" in out[29].get_text()
