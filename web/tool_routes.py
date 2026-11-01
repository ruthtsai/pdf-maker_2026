"""HTTP routes for the single-PDF tools: split and compress."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import file_utils, splitter
from core.file_utils import PdfEncryptedError
from core.jobs import Job, job_manager
from models.file_item import FileItem, FileStatus, FileType
from web import store
from web.editor_routes import hold_or_404

router = APIRouter()


class SplitOptions(BaseModel):
    file_id: str
    mode: Literal["ranges", "every"] = "ranges"
    ranges: str = ""
    every: int = 1


def _ready_pdf(file_id: str) -> FileItem:
    item = store.get(file_id)
    if not item:
        raise HTTPException(404, detail="找不到檔案（可能已閒置過久被清除，請重新上傳）")
    if item.file_type != FileType.PDF:
        raise HTTPException(400, detail="只能處理 PDF 檔案")
    if item.status != FileStatus.OK:
        raise HTTPException(400, detail=item.error_message or "檔案尚未就緒")
    return item


def _base_name(item: FileItem) -> str:
    return file_utils.sanitize_filename(Path(item.original_name).stem, fallback="document")


@router.post("/api/split")
def start_split(options: SplitOptions):
    item = _ready_pdf(options.file_id)
    try:
        if options.mode == "ranges":
            groups = splitter.groups_by_ranges(options.ranges, item.page_count)
        else:
            groups = splitter.groups_every(options.every, item.page_count)
    except splitter.SplitError as exc:
        raise HTTPException(400, detail=str(exc))

    base_name = _base_name(item)
    file_name = splitter.part_name(base_name, groups[0]) if len(groups) == 1 else f"{base_name}.zip"
    out_dir = file_utils.output_dir() / uuid.uuid4().hex
    hold = hold_or_404([item.id])
    job = job_manager.create()

    def task(job: Job):
        try:
            return splitter.split_pdf(
                Path(item.stored_path),
                groups,
                out_dir,
                base_name,
                password=store.password(item.id),
                progress_cb=job.progress_cb,
                cancel_check=job.cancel_check,
            )
        except PdfEncryptedError as exc:
            raise RuntimeError(str(exc)) from exc
        finally:
            hold.release()

    job_manager.run(job, task)
    return {"job_id": job.id, "parts": len(groups), "file_name": file_name}
