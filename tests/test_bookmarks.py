import io

import pymupdf as fitz
import pypdf
import pytest

from core.editor import (
    Bookmark,
    EditRecipe,
    PageRef,
    RecipeError,
    Source,
    export_pdf,
    normalize_bookmarks,
    validate_recipe,
)
from tests.helpers import make_pdf


def _export(tmp_path, refs, bookmarks):
    src = make_pdf(tmp_path / "s.pdf", [f"P{i + 1}" for i in range(6)])
    return export_pdf(EditRecipe(pages=refs, bookmarks=bookmarks), {"s": Source(src)}, tmp_path / "o.pdf")


def _tree(path):
    """[(depth, title, 0-based page or None)] as read by an independent reader (pypdf)."""
    reader = pypdf.PdfReader(str(path))
    rows = []

    def walk(items, depth):
        for it in items:
            if isinstance(it, list):
                walk(it, depth + 1)
            else:
                page = reader.get_destination_page_number(it) if it.page is not None else None
                rows.append((depth, it.title, page))

    walk(reader.outline, 0)
    return rows


def test_bookmarks_written_with_levels_and_cjk_titles(tmp_path):
    refs = [PageRef("s", i) for i in range(6)]
    out = _export(
        tmp_path,
        refs,
        [Bookmark(1, "前言", 0), Bookmark(1, "第一章 Chapter (1)", 1), Bookmark(2, "1.1 小節", 2), Bookmark(1, "無目標", -1)],
    )
    assert _tree(out) == [(0, "前言", 0), (0, "第一章 Chapter (1)", 1), (1, "1.1 小節", 2), (0, "無目標", None)]


def test_none_writes_no_outline_and_empty_list_clears(tmp_path):
    refs = [PageRef("s", 0)]
    assert _tree(_export(tmp_path, refs, None)) == []
    assert _tree(_export(tmp_path, refs, [])) == []


def test_bookmark_targets_are_output_indexes(tmp_path):
    # reorder: output page 0 shows source page 5
    out = _export(tmp_path, [PageRef("s", 5), PageRef("s", 0)], [Bookmark(1, "最後一頁", 0)])
    assert _tree(out) == [(0, "最後一頁", 0)]
    with fitz.open(out) as d:
        assert "P6" in d[0].get_text()


def test_normalize_clamps_levels():
    toc = normalize_bookmarks(
        [Bookmark(3, "a", 0), Bookmark(1, "b", 1), Bookmark(5, "c", 2), Bookmark(1, "  ", 99)], total=3
    )
    assert toc == [[1, "a", 1], [1, "b", 2], [2, "c", 3], [1, "(未命名)", -1]]


def test_validation_rejects_target_outside_document():
    recipe = EditRecipe(pages=[PageRef("a", 0)], bookmarks=[Bookmark(1, "x", 3)])
    with pytest.raises(RecipeError, match="不存在的頁面"):
        validate_recipe(recipe, {"a": 1})
    with pytest.raises(RecipeError, match="層級"):
        validate_recipe(EditRecipe(pages=[PageRef("a", 0)], bookmarks=[Bookmark(0, "x", 0)]), {"a": 1})


def test_preview_does_not_need_bookmarks_but_accepts_them(tmp_path):
    from core.editor import render_preview

    src = make_pdf(tmp_path / "s.pdf", ["P1", "P2"])
    recipe = EditRecipe(pages=[PageRef("s", 0), PageRef("s", 1)], bookmarks=[Bookmark(1, "x", 0)])
    assert render_preview(recipe, {"s": Source(src)}, 1, 300)[:4] == b"\x89PNG"
