"""Page-level PDF editing. A document is described by a "recipe" (an ordered list of page
references plus overlays); nothing touches the original files — export builds a new PDF."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pymupdf as fitz

from core import overlay
from core.file_utils import PdfEncryptedError

ProgressCallback = Callable[[int, int, str], None]

MAX_PAGES = 5000
VALID_ROTATIONS = (0, 90, 180, 270)


class RecipeError(ValueError):
    pass


@dataclass
class PageRef:
    src: str          # file id
    idx: int          # 0-based page index in that source
    rot: int = 0      # extra clockwise rotation applied on top of the page's own /Rotate


@dataclass
class Source:
    path: Path
    name: str = ""
    password: str | None = None


LABEL_STYLES = ("D", "r", "R", "a", "A", "")   # decimal, roman, ROMAN, alpha, ALPHA, none (prefix only)
NUMBER_FORMATS = ("number", "roman", "roman_upper", "of")
STAMP_GLYPHS = "0123456789 第頁共／"   # every character a number stamp can contain


@dataclass
class LabelRule:
    """A PDF page-label range: viewers show these in their page box (i, ii, iii, 1, 2, ...)."""

    start: int            # 0-based output page where this rule begins
    style: str = "D"
    prefix: str = ""
    first: int = 1


@dataclass
class NumberStamp:
    """Page numbers printed onto the pages."""

    v_pos: str = "bottom"     # top | bottom
    h_pos: str = "center"     # left | center | right
    fmt: str = "number"
    start_page: int = 1       # 1-based output page where numbering begins
    start_number: int = 1
    font_size: float = 10
    margin: float = 28


@dataclass
class StampSpec:
    """An image stamp (seal / signature). Geometry is relative to the page's visual frame:
    (cx, cy) is the centre as a fraction of page width/height and `w` the un-rotated width as a
    fraction of page width, so one placement fits pages of different sizes."""

    image_path: Path
    cx: float = 0.5
    cy: float = 0.5
    w: float = 0.25
    rot: float = 0.0          # clockwise degrees
    opacity: float = 1.0
    pages: list[int] | None = None   # 0-based output pages; None = every page
    name: str = ""


@dataclass
class Bookmark:
    level: int      # 1 = top level
    title: str
    page: int       # 0-based output page, or -1 for a heading without a destination


@dataclass
class EditRecipe:
    pages: list[PageRef] = field(default_factory=list)
    labels: list[LabelRule] = field(default_factory=list)
    number_stamp: NumberStamp | None = None
    bookmarks: list[Bookmark] | None = None   # None: write no outline; []: explicitly empty
    stamps: list[StampSpec] = field(default_factory=list)


def _open_source(src: Source) -> fitz.Document:
    doc = fitz.open(src.path)
    if doc.needs_pass:
        if not src.password or not doc.authenticate(src.password):
            doc.close()
            raise PdfEncryptedError(f"{src.name or src.path.name}：PDF 有密碼保護或密碼錯誤")
    return doc


def validate_recipe(recipe: EditRecipe, page_counts: dict[str, int]) -> None:
    if not recipe.pages:
        raise RecipeError("沒有任何頁面可輸出")
    if len(recipe.pages) > MAX_PAGES:
        raise RecipeError(f"頁數超過上限 {MAX_PAGES}")
    for n, ref in enumerate(recipe.pages, start=1):
        if ref.src not in page_counts:
            raise RecipeError(f"第 {n} 頁的來源檔案不存在")
        if not 0 <= ref.idx < page_counts[ref.src]:
            raise RecipeError(f"第 {n} 頁指向不存在的來源頁碼")
        if ref.rot not in VALID_ROTATIONS:
            raise RecipeError(f"第 {n} 頁的旋轉角度無效")

    total = len(recipe.pages)
    for rule in recipe.labels:
        if rule.style not in LABEL_STYLES:
            raise RecipeError("頁碼標籤樣式無效")
        if not 0 <= rule.start < total:
            raise RecipeError(f"頁碼標籤的起始頁超出範圍（1-{total}）")
        if rule.first < 1:
            raise RecipeError("頁碼標籤的起始號碼需大於等於 1")
    ns = recipe.number_stamp
    if ns:
        if ns.fmt not in NUMBER_FORMATS or ns.v_pos not in ("top", "bottom") or ns.h_pos not in ("left", "center", "right"):
            raise RecipeError("蓋印頁碼的位置或格式無效")
        if not 1 <= ns.start_page <= total:
            raise RecipeError(f"蓋印頁碼的起始頁超出範圍（1-{total}）")
        if ns.start_number < 0:
            raise RecipeError("蓋印頁碼的起始號碼不可為負數")
        if not 4 <= ns.font_size <= 72:
            raise RecipeError("蓋印頁碼的字型大小需介於 4–72")
    for st in recipe.stamps:
        label = st.name or st.image_path.name
        if not st.image_path.exists():
            raise RecipeError(f"章「{label}」的圖片已不存在")
        if not 0.01 <= st.w <= 3:
            raise RecipeError(f"章「{label}」的大小無效")
        if not (-0.5 <= st.cx <= 1.5 and -0.5 <= st.cy <= 1.5):
            raise RecipeError(f"章「{label}」的位置超出頁面太多")
        if not 0 <= st.opacity <= 1:
            raise RecipeError(f"章「{label}」的透明度需介於 0–1")
        if st.pages is not None and any(not 0 <= i < total for i in st.pages):
            raise RecipeError(f"章「{label}」指定的頁面不存在")
    for b in recipe.bookmarks or []:
        if b.level < 1:
            raise RecipeError("書籤層級需大於等於 1")
        if b.page >= total:
            raise RecipeError(f"書籤「{b.title}」指向不存在的頁面")


def assemble_pages(docs: dict[str, fitz.Document], refs: list[PageRef]) -> fitz.Document:
    """Whole sources are inserted and then trimmed/reordered with select(), because that keeps
    internal links pointing at the right (moved) pages. A page used more than once gets its own
    full copy of the source so each use can be rotated independently."""
    out = fitz.open()
    copies: dict[str, list[int]] = {}
    uses: dict[tuple[str, int], int] = {}
    order: list[int] = []
    for ref in refs:
        n = uses.get((ref.src, ref.idx), 0)
        uses[(ref.src, ref.idx)] = n + 1
        offsets = copies.setdefault(ref.src, [])
        while len(offsets) <= n:
            offsets.append(out.page_count)
            out.insert_pdf(docs[ref.src], links=True, annots=True)
        order.append(offsets[n] + ref.idx)
    out.select(order)
    for i, ref in enumerate(refs):
        if ref.rot:
            page = out[i]
            page.set_rotation((page.rotation + ref.rot) % 360)
    return out


def to_roman(n: int) -> str:
    if n <= 0:
        return str(n)
    out = []
    for value, sym in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
                       (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= value:
            out.append(sym)
            n -= value
    return "".join(out)


def format_page_number(fmt: str, n: int, last: int) -> str:
    if fmt == "roman":
        return to_roman(n).lower()
    if fmt == "roman_upper":
        return to_roman(n)
    if fmt == "of":
        return f"第 {n} 頁／共 {last} 頁"
    return str(n)


def _draw_number(canvas, cfg: NumberStamp, out_index: int, total: int) -> None:
    """`out_index` is the page's 0-based position in the final document."""
    if out_index + 1 < cfg.start_page:
        return
    n = cfg.start_number + (out_index + 1 - cfg.start_page)
    last = cfg.start_number + (total - cfg.start_page)
    text = format_page_number(cfg.fmt, n, last)
    font = overlay.cjk_font(STAMP_GLYPHS) if cfg.fmt == "of" else None
    if font is None:
        width = fitz.get_text_length(text, fontname="helv", fontsize=cfg.font_size)
    else:
        width = font.text_length(text, fontsize=cfg.font_size)
    x = {"left": cfg.margin, "center": (canvas.width - width) / 2, "right": canvas.width - cfg.margin - width}[cfg.h_pos]
    y = cfg.margin + cfg.font_size if cfg.v_pos == "top" else canvas.height - cfg.margin
    canvas.text(max(0.0, x), y, text, cfg.font_size, font)


def _draw_stamp(canvas, spec: StampSpec) -> None:
    png, bw, bh = overlay.stamp_png_for(spec.image_path, spec.w * canvas.width, spec.rot, spec.opacity)
    cx, cy = spec.cx * canvas.width, spec.cy * canvas.height
    canvas.image(fitz.Rect(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), png)


def apply_overlays(doc: fitz.Document, recipe: EditRecipe, indexes: list[int], total: int) -> None:
    """Draws page numbers and stamps on every page of `doc`; indexes[i] is page i's position in
    the final document."""
    if not recipe.number_stamp and not recipe.stamps:
        return
    for i, page in enumerate(doc):
        at = indexes[i]
        with overlay.visual_frame(page) as canvas:
            if recipe.number_stamp:
                _draw_number(canvas, recipe.number_stamp, at, total)
            for spec in recipe.stamps:
                if spec.pages is None or at in spec.pages:
                    _draw_stamp(canvas, spec)


def _pdf_text_string(text: str) -> str:
    """PDF text string literal; non-ASCII text must be UTF-16BE with a BOM or viewers show mojibake."""
    if text.isascii():
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        return f"({escaped})"
    return "<FEFF" + text.encode("utf-16-be").hex().upper() + ">"


def normalize_bookmarks(bookmarks: list[Bookmark], total: int) -> list[list]:
    """PDF outlines need the first entry at level 1 and no level to jump more than one deeper
    than the entry before it; clamp rather than fail so a stray indent never loses the outline."""
    toc: list[list] = []
    prev = 0
    for b in bookmarks:
        level = max(1, min(b.level, prev + 1))
        title = b.title.strip() or "(未命名)"
        page = b.page + 1 if 0 <= b.page < total else -1
        toc.append([level, title, page])
        prev = level
    return toc


def apply_bookmarks(doc: fitz.Document, bookmarks: list[Bookmark] | None) -> None:
    if bookmarks is None:
        return
    doc.set_toc(normalize_bookmarks(bookmarks, doc.page_count))


def apply_labels(doc: fitz.Document, labels: list[LabelRule]) -> None:
    if not labels:
        return
    rules = sorted(labels, key=lambda r: r.start)
    if rules[0].start != 0:
        rules.insert(0, LabelRule(start=0, style="D", prefix="", first=1))
    entries = []
    for r in rules:
        parts = []
        if r.style:
            parts.append(f"/S /{r.style}")
        if r.prefix:
            parts.append(f"/P {_pdf_text_string(r.prefix)}")
        if r.first != 1:
            parts.append(f"/St {r.first}")
        entries.append(f"{r.start} <<{' '.join(parts)}>>")
    doc.xref_set_key(doc.pdf_catalog(), "PageLabels", f"<</Nums [{' '.join(entries)}]>>")


def build_document(
    recipe: EditRecipe,
    sources: dict[str, Source],
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> fitz.Document:
    def step(cur: int, total: int, msg: str) -> None:
        if cancel_check and cancel_check():
            raise InterruptedError("cancelled")
        if progress_cb:
            progress_cb(cur, total, msg)

    used = list(dict.fromkeys(ref.src for ref in recipe.pages))
    total_steps = len(used) + 2
    docs: dict[str, fitz.Document] = {}
    try:
        for n, src_id in enumerate(used):
            step(n, total_steps, f"載入 {sources[src_id].name or src_id}")
            docs[src_id] = _open_source(sources[src_id])

        step(len(used), total_steps, "組合頁面")
        out = assemble_pages(docs, recipe.pages)
        step(len(used) + 1, total_steps, "套用設定")
        apply_overlays(out, recipe, list(range(out.page_count)), out.page_count)
        apply_labels(out, recipe.labels)
        apply_bookmarks(out, recipe.bookmarks)
        return out
    finally:
        for d in docs.values():
            d.close()


def export_pdf(
    recipe: EditRecipe,
    sources: dict[str, Source],
    output_path: Path,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    out = build_document(recipe, sources, progress_cb, cancel_check)
    try:
        if progress_cb:
            progress_cb(len(set(r.src for r in recipe.pages)) + 2, len(set(r.src for r in recipe.pages)) + 2, "寫入輸出檔案")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        out.save(str(output_path), garbage=3, deflate=True)
    finally:
        out.close()
    return output_path


def render_preview(recipe: EditRecipe, sources: dict[str, Source], out_index: int, width: int) -> bytes:
    """Renders one output page (rotation + overlays applied) as PNG without building the whole document."""
    ref = recipe.pages[out_index]
    src = _open_source(sources[ref.src])
    try:
        doc = fitz.open()
        doc.insert_pdf(src, from_page=ref.idx, to_page=ref.idx)
    finally:
        src.close()
    try:
        if ref.rot:
            doc[0].set_rotation((doc[0].rotation + ref.rot) % 360)
        apply_overlays(doc, recipe, [out_index], len(recipe.pages))
        page = doc[0]
        zoom = max(0.1, width / page.rect.width)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()
