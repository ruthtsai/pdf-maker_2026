import io

import pymupdf as fitz
import pytest
from PIL import Image

from core.editor import EditRecipe, NumberStamp, PageRef, RecipeError, Source, StampSpec, export_pdf, validate_recipe


def _png(path, size=(100, 50), color=(255, 0, 0, 255)):
    Image.new("RGBA", size, color).save(path)
    return path


def _blank(path, n=1, size=(300, 400)):
    doc = fitz.open()
    for _ in range(n):
        doc.new_page(width=size[0], height=size[1])
    doc.save(str(path))
    doc.close()
    return path


def _render(path, page=0, scale=1.0):
    with fitz.open(path) as d:
        pix = d[page].get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
        return pix


def _px(pix, x, y):
    i = (int(y) * pix.width + int(x)) * 3
    return tuple(pix.samples[i : i + 3])


def _export(tmp_path, stamps, n=1, rot=0, numbers=None, size=(300, 400)):
    src = _blank(tmp_path / "s.pdf", n, size)
    recipe = EditRecipe(pages=[PageRef("s", i, rot) for i in range(n)], stamps=stamps, number_stamp=numbers)
    return export_pdf(recipe, {"s": Source(src)}, tmp_path / "o.pdf")


def test_stamp_lands_at_requested_position_and_size(tmp_path):
    img = _png(tmp_path / "red.png", (100, 50))
    # width = 40% of 300pt = 120pt -> height 60pt, centred at (25%, 75%) = (75, 300)
    out = _export(tmp_path, [StampSpec(img, cx=0.25, cy=0.75, w=0.4)])
    pix = _render(out)
    assert _px(pix, 75, 300) == (255, 0, 0)                    # centre
    assert _px(pix, 75 - 58, 300 - 28) == (255, 0, 0)          # inside, near top-left corner
    assert _px(pix, 75 - 65, 300) == (255, 255, 255)           # just outside to the left
    assert _px(pix, 75, 300 - 35) == (255, 255, 255)           # just above
    assert _px(pix, 200, 100) == (255, 255, 255)               # elsewhere untouched


def test_stamp_rotation_swaps_the_footprint(tmp_path):
    img = _png(tmp_path / "bar.png", (200, 20))               # a long thin bar
    out = _export(tmp_path, [StampSpec(img, cx=0.5, cy=0.5, w=0.6, rot=90)])   # 180pt x 18pt -> upright bar
    pix = _render(out)
    assert _px(pix, 150, 200 - 80) == (255, 0, 0)             # extends vertically after a 90 degree turn
    assert _px(pix, 150 + 70, 200) == (255, 255, 255)         # no longer extends horizontally


def test_stamp_opacity_blends_with_page(tmp_path):
    img = _png(tmp_path / "red.png", (50, 50))
    out = _export(tmp_path, [StampSpec(img, cx=0.5, cy=0.5, w=0.3, opacity=0.5)])
    r, g, b = _px(_render(out), 150, 200)
    assert r == 255 and 100 < g < 160 and 100 < b < 160       # roughly 50% red over white


def test_transparent_png_keeps_page_visible(tmp_path):
    img = tmp_path / "ring.png"
    im = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    for x in range(40, 60):
        for y in range(40, 60):
            im.putpixel((x, y), (0, 0, 255, 255))
    im.save(img)
    out = _export(tmp_path, [StampSpec(img, cx=0.5, cy=0.5, w=0.5)])   # 150pt wide; blue square is the middle 20%
    pix = _render(out)
    assert _px(pix, 150, 200) == (0, 0, 255)
    assert _px(pix, 150 - 50, 200) == (255, 255, 255)                  # transparent part leaves the page white


def test_page_scope(tmp_path):
    img = _png(tmp_path / "red.png", (40, 40))
    out = _export(tmp_path, [StampSpec(img, cx=0.5, cy=0.5, w=0.3, pages=[1])], n=3)
    centres = [_px(_render(out, i), 150, 200) for i in range(3)]
    assert centres == [(255, 255, 255), (255, 0, 0), (255, 255, 255)]


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_stamp_stays_where_the_viewer_shows_it_on_rotated_pages(tmp_path, rot):
    """A stamp placed at the visual centre-right must be there in the rendered (rotated) page."""
    img = _png(tmp_path / "red.png", (40, 40))
    out = _export(tmp_path, [StampSpec(img, cx=0.8, cy=0.5, w=0.1)], rot=rot)
    pix = _render(out)
    assert _px(pix, pix.width * 0.8, pix.height * 0.5) == (255, 0, 0)
    assert _px(pix, pix.width * 0.2, pix.height * 0.5) == (255, 255, 255)


def test_stamp_and_page_number_coexist(tmp_path):
    img = _png(tmp_path / "red.png", (40, 40))
    out = _export(tmp_path, [StampSpec(img, w=0.2)], numbers=NumberStamp(fmt="number", start_number=7))
    with fitz.open(out) as d:
        assert "7" in d[0].get_text()
    assert _px(_render(out), 150, 200) == (255, 0, 0)


def test_same_stamp_on_many_pages_is_stored_once(tmp_path):
    big = tmp_path / "sig.png"
    noise = Image.effect_noise((400, 200), 80).convert("RGBA")           # incompressible-ish
    noise.save(big)
    one = _export(tmp_path, [StampSpec(big, w=0.3)], n=1)
    size_one = one.stat().st_size
    many = _export(tmp_path, [StampSpec(big, w=0.3)], n=25)
    assert many.stat().st_size < size_one * 4, "stamp image appears to be embedded once per page"


def test_oversized_images_are_downscaled(tmp_path):
    huge = tmp_path / "huge.png"
    Image.effect_noise((3000, 1500), 90).convert("RGBA").save(huge)
    out = _export(tmp_path, [StampSpec(huge, w=0.2)])                    # only 60pt wide on the page
    assert out.stat().st_size < 400_000


@pytest.mark.parametrize(
    "kwargs, message",
    [
        (dict(w=0), "大小無效"),
        (dict(cx=3), "位置超出"),
        (dict(opacity=2), "透明度"),
        (dict(pages=[5]), "指定的頁面不存在"),
    ],
)
def test_validation(tmp_path, kwargs, message):
    img = _png(tmp_path / "red.png")
    recipe = EditRecipe(pages=[PageRef("a", 0)], stamps=[StampSpec(img, **kwargs)])
    with pytest.raises(RecipeError, match=message):
        validate_recipe(recipe, {"a": 1})


def test_missing_image_is_reported(tmp_path):
    recipe = EditRecipe(pages=[PageRef("a", 0)], stamps=[StampSpec(tmp_path / "gone.png", name="gone")])
    with pytest.raises(RecipeError, match="圖片已不存在"):
        validate_recipe(recipe, {"a": 1})
