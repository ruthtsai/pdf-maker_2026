"""HTTP routes for the page editor (previews, document info, export)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
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


class EditExport(BaseModel):
    pages: list[EditPage]
    output_name: str = "edited.pdf"


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

    recipe = editor.EditRecipe(pages=[editor.PageRef(p.src, p.idx, p.rot) for p in body.pages])
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
