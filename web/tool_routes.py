"""HTTP routes for the single-PDF tools: split and compress."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import compressor, file_utils, splitter
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


class CompressOptions(BaseModel):
    file_id: str
    level: Literal["light", "standard", "strong"] = "standard"


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


@router.post("/api/compress")
def start_compress(options: CompressOptions):
    item = _ready_pdf(options.file_id)
    output_path = file_utils.output_dir() / uuid.uuid4().hex / f"{_base_name(item)}_compressed.pdf"
    hold = hold_or_404([item.id])
    job = job_manager.create()

    def task(job: Job):
        try:
            result = compressor.compress_pdf(
                Path(item.stored_path),
                output_path,
                options.level,
                password=store.password(item.id),
                progress_cb=job.progress_cb,
                cancel_check=job.cancel_check,
            )
        except PdfEncryptedError as exc:
            raise RuntimeError(str(exc)) from exc
        finally:
            hold.release()
        job.details = {
            "original_size": result.original_size,
            "compressed_size": result.compressed_size,
            "saved_ratio": round(result.saved_ratio, 4),
            "compressed": result.compressed,
        }
        if not result.compressed:
            job.warning = "這份檔案已無法再壓縮，輸出的是原檔的副本。"
        return result.path

    job_manager.run(job, task)
    return {"job_id": job.id, "file_name": output_path.name}
