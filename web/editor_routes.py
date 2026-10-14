"""HTTP routes for the page editor (previews, document info, export)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from core import editor, file_utils, render
from core.file_utils import PdfEncryptedError
from core.jobs import Job, job_manager
from models.file_item import FileItem, FileStatus, FileType
from web import store

router = APIRouter()


# ---------- schemas ----------


class EditPage(BaseModel):
    src: str
    idx: int = Field(ge=0)
    rot: int = 0


class LabelRuleIn(BaseModel):
    start: int = Field(ge=0)
    style: str = "D"
    prefix: str = ""
    first: int = 1


class NumberStampIn(BaseModel):
    v_pos: str = "bottom"
    h_pos: str = "center"
    fmt: str = "number"
    start_page: int = 1
    start_number: int = 1
    font_size: float = 10
    margin: float = 28


class BookmarkIn(BaseModel):
    level: int = 1
    title: str = ""
    page: int = -1


class StampIn(BaseModel):
    file_id: str
    cx: float = 0.5
    cy: float = 0.5
    w: float = 0.25
    rot: float = 0.0
    opacity: float = 1.0
    pages: list[int] | None = None
    name: str = ""


class EditExport(BaseModel):
    pages: list[EditPage]
    output_name: str = "edited.pdf"
    page_labels: list[LabelRuleIn] = []
    page_numbers: NumberStampIn | None = None
    bookmarks: list[BookmarkIn] | None = None
    stamps: list[StampIn] = []


# ---------- helpers ----------


def _pdf_item(file_id: str) -> FileItem:
    item = store.get(file_id)
    if not item:
        raise HTTPException(404, detail="找不到檔案（可能已閒置過久被清除，請重新開啟）")
    if item.file_type != FileType.PDF:
        raise HTTPException(400, detail="只支援 PDF 檔案")
    if item.status == FileStatus.ENCRYPTED and file_id not in store.passwords:
        raise HTTPException(403, detail="PDF 有密碼保護，請先輸入密碼")
    if item.status == FileStatus.ERROR:
        raise HTTPException(400, detail=item.error_message or "檔案無法開啟")
    return item


def _image_item(file_id: str) -> FileItem:
    item = store.get(file_id)
    if not item:
        raise HTTPException(404, detail="找不到圖片檔案（可能已閒置過久被清除，請重新上傳）")
    if item.file_type != FileType.IMAGE or item.status != FileStatus.OK:
        raise HTTPException(400, detail=f"「{item.original_name}」不是可用的圖片")
    return item


def _recipe_from_request(body: EditExport) -> tuple[editor.EditRecipe, dict[str, editor.Source]]:
    sources: dict[str, editor.Source] = {}
    page_counts: dict[str, int] = {}
    for page in body.pages:
        if page.src in sources:
            continue
        item = _pdf_item(page.src)
        sources[page.src] = editor.Source(
            path=Path(item.stored_path), name=item.original_name, password=store.passwords.get(page.src)
        )
        page_counts[page.src] = item.page_count

    recipe = editor.EditRecipe(
        pages=[editor.PageRef(p.src, p.idx, p.rot) for p in body.pages],
        labels=[editor.LabelRule(r.start, r.style, r.prefix, r.first) for r in body.page_labels],
        number_stamp=editor.NumberStamp(**body.page_numbers.model_dump()) if body.page_numbers else None,
        bookmarks=None
        if body.bookmarks is None
        else [editor.Bookmark(b.level, b.title, b.page) for b in body.bookmarks],
        stamps=[
            editor.StampSpec(
                image_path=Path(_image_item(st.file_id).stored_path),
                cx=st.cx,
                cy=st.cy,
                w=st.w,
                rot=st.rot,
                opacity=st.opacity,
                pages=st.pages,
                name=st.name,
            )
            for st in body.stamps
        ],
    )
    try:
        editor.validate_recipe(recipe, page_counts)
    except editor.RecipeError as exc:
        raise HTTPException(400, detail=str(exc))
    return recipe, sources


# ---------- routes ----------


@router.get("/api/files/{file_id}/info")
def document_info(file_id: str):
    item = _pdf_item(file_id)
    try:
        return render.inspect_document(Path(item.stored_path), store.passwords.get(file_id))
    except PdfEncryptedError as exc:
        raise HTTPException(403, detail=str(exc))


@router.get("/api/files/{file_id}/raw")
def raw_image(file_id: str):
    """The uploaded image itself (used to show a stamp at full quality while placing it)."""
    item = _image_item(file_id)
    return FileResponse(item.stored_path, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/files/{file_id}/pages/{page_index}/image")
def page_image(
    file_id: str,
    page_index: int,
    w: int = Query(240, ge=render.MIN_WIDTH, le=render.MAX_WIDTH),
    fmt: Literal["jpeg", "png"] = "jpeg",
):
    item = _pdf_item(file_id)
    try:
        data = render.render_page(
            file_id, Path(item.stored_path), page_index, w, store.passwords.get(file_id), fmt
        )
    except PdfEncryptedError as exc:
        raise HTTPException(403, detail=str(exc))
    except IndexError as exc:
        raise HTTPException(404, detail=str(exc))
    return Response(
        content=data,
        media_type="image/png" if fmt == "png" else "image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.post("/api/edit/export")
def export_edit(body: EditExport):
    recipe, sources = _recipe_from_request(body)

    name = file_utils.sanitize_filename(body.output_name.strip() or "edited.pdf", fallback="edited.pdf")
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    output_path = file_utils.new_output_path(name)

    file_ids = list(sources)
    store.mark_active(file_ids)
    job = job_manager.create()

    def task(job: Job):
        try:
            return editor.export_pdf(
                recipe, sources, output_path, progress_cb=job.progress_cb, cancel_check=job.cancel_check
            )
        except PdfEncryptedError as exc:
            raise RuntimeError(str(exc)) from exc
        finally:
            store.unmark_active(file_ids)

    job_manager.run(job, task)
    return {"job_id": job.id, "page_count": len(recipe.pages)}


@router.post("/api/edit/preview")
def preview_edit_page(body: EditExport, index: int = Query(0, ge=0), w: int = Query(700, ge=100, le=1600)):
    """Renders one output page exactly as the export would (rotation, page numbers, ...)."""
    recipe, sources = _recipe_from_request(body)
    if index >= len(recipe.pages):
        raise HTTPException(404, detail="頁面不存在")
    try:
        png = editor.render_preview(recipe, sources, index, w)
    except PdfEncryptedError as exc:
        raise HTTPException(403, detail=str(exc))
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})
