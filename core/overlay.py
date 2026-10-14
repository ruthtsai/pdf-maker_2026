"""Draw text / images on a page at positions given in the page's *visual* frame
(what a viewer shows: rotation and crop box applied, origin top-left).

PyMuPDF's drawing coordinates on rotated or cropped pages don't line up with the visual
frame, so each draw temporarily drops the rotation and crop box, converts the visual
position to media-box coordinates itself, and restores both afterwards. This was checked
pixel-for-pixel against an upright reference for every rotation with and without a crop box.
"""

from __future__ import annotations

import io
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

import pymupdf as fitz
from PIL import Image

_subset_cache: dict[str, fitz.Font] = {}


def cjk_font(chars: str) -> fitz.Font:
    """The built-in CJK font reduced to `chars`. Embedding the whole font on every stamped page
    costs ~180 KB per page; the subset is a few KB. Only our own font is subset, never the
    document's original fonts."""
    key = "".join(sorted(set(chars)))
    font = _subset_cache.get(key)
    if font is None:
        import io

        from fontTools import subset
        from fontTools.ttLib import TTFont

        options = subset.Options()
        options.layout_features = ["*"]
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=key)
        tt = TTFont(io.BytesIO(fitz.Font("cjk").buffer))
        subsetter.subset(tt)
        out = io.BytesIO()
        tt.save(out)
        font = fitz.Font(fontbuffer=out.getvalue())
        _subset_cache[key] = font
    return font


def _to_media(rot: int, crop: fitz.Rect, vw: float, vh: float, x: float, y: float) -> tuple[float, float]:
    a, b = {0: (x, y), 90: (y, vw - x), 180: (vw - x, vh - y), 270: (vh - y, x)}[rot]
    return crop.x0 + a, crop.y0 + b


def _rect_to_media(rot: int, crop: fitz.Rect, vw: float, vh: float, r: fitz.Rect) -> fitz.Rect:
    x0, y0 = _to_media(rot, crop, vw, vh, r.x0, r.y0)
    x1, y1 = _to_media(rot, crop, vw, vh, r.x1, r.y1)
    return fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


@contextmanager
def visual_frame(page: fitz.Page):
    """Yields helpers that draw using visual-frame coordinates."""
    rot = page.rotation
    crop = fitz.Rect(page.cropbox)
    vw, vh = page.rect.width, page.rect.height
    page.set_cropbox(page.mediabox)
    page.set_rotation(0)
    try:
        yield _Canvas(page, rot, crop, vw, vh)
    finally:
        page.set_cropbox(crop)
        page.set_rotation(rot)


class _Canvas:
    def __init__(self, page: fitz.Page, rot: int, crop: fitz.Rect, vw: float, vh: float):
        self.page, self.rot, self.crop = page, rot, crop
        self.width, self.height = vw, vh

    def text(self, x: float, y: float, text: str, size: float, font: fitz.Font | None = None) -> None:
        """Baseline starts at visual (x, y). `font` None -> built-in Helvetica."""
        point = _to_media(self.rot, self.crop, self.width, self.height, x, y)
        if font is None:
            self.page.insert_text(point, text, fontname="helv", fontsize=size, rotate=self.rot)
        else:
            self.page.insert_font(fontname="cjkf", fontbuffer=font.buffer)
            self.page.insert_text(point, text, fontname="cjkf", fontsize=size, rotate=self.rot)

    def image(self, rect: fitz.Rect, png_bytes: bytes) -> None:
        target = _rect_to_media(self.rot, self.crop, self.width, self.height, rect)
        self.page.insert_image(target, stream=png_bytes, rotate=self.rot)


@lru_cache(maxsize=64)
def _load_stamp_image(path: str, mtime: float) -> Image.Image:
    with Image.open(path) as img:
        return img.convert("RGBA")


@lru_cache(maxsize=128)
def render_stamp_png(path: str, mtime: float, width_pt: float, rot: float, opacity: float) -> tuple[bytes, float, float]:
    """The stamp image scaled so its un-rotated width is `width_pt` points, rotated clockwise by
    `rot` degrees on a transparent canvas, with its alpha multiplied by `opacity`.
    Returns (png bytes, bounding width pt, bounding height pt)."""
    img = _load_stamp_image(path, mtime)
    iw, ih = img.size
    pt_per_px = width_pt / iw

    # No point embedding far more pixels than will ever be shown (~4 px per point).
    limit = max(64, int(width_pt * 4))
    if iw > limit:
        k = limit / iw
        img = img.resize((limit, max(1, round(ih * k))), Image.LANCZOS)
        pt_per_px = width_pt / img.width

    if opacity < 1.0:
        img = img.copy()
        alpha = img.getchannel("A").point(lambda a: int(a * opacity))
        img.putalpha(alpha)
    if rot % 360:
        img = img.rotate(-rot, expand=True, resample=Image.BICUBIC)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), img.width * pt_per_px, img.height * pt_per_px


def stamp_png_for(path: Path, width_pt: float, rot: float, opacity: float) -> tuple[bytes, float, float]:
    # Width is rounded so pages of (nearly) equal size share one rendered image.
    return render_stamp_png(str(path), path.stat().st_mtime, round(width_pt, 1), round(rot, 2), round(opacity, 3))
