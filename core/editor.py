"""Page-level PDF editing. A document is described by a "recipe" (an ordered list of page
references plus overlays); nothing touches the original files — export builds a new PDF."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pymupdf as fitz

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


@dataclass
class EditRecipe:
    pages: list[PageRef] = field(default_factory=list)


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
