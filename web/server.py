"""FastAPI backend. Owns the HTTP layer only — all real work happens in core/."""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core import converter, file_utils, merger
from core.file_utils import ImageCorruptedError, PdfCorruptedError, PdfEncryptedError
from core.jobs import Job, JobStatus, job_manager
from models.file_item import FileItem, FileStatus, FileType
from web import store
from web.editor_routes import router as editor_router

app = FastAPI(title="PDF／影像合併與轉換工具")
app.include_router(editor_router)

# A PyInstaller onefile build extracts bundled data under sys._MEIPASS instead of
# next to this .py file (which isn't a real file on disk once frozen).
if getattr(sys, "frozen", False):
    STATIC_DIR = Path(sys._MEIPASS) / "web" / "static"
else:
    STATIC_DIR = Path(__file__).parent / "static"


# ---------- schemas ----------


class MergeOptions(BaseModel):
    file_ids: list[str]
    output_name: str = "merged.pdf"
    page_size: Literal["original", "a4"] = "original"
    image_fit: Literal["fill", "center"] = "center"


class ConvertOptions(BaseModel):
    file_id: str
    page_range: str = ""
    format: Literal["png", "jpg"] = "png"
    dpi: int = 200
    jpg_quality: int = 90
    pack_zip: bool = False
    output_name: str = ""


class PasswordPayload(BaseModel):
    password: str


# ---------- helpers ----------


def _file_item_to_json(item: FileItem) -> dict:
    return {
        "id": item.id,
        "name": item.original_name,
        "type": item.file_type.value,
        "page_count": item.page_count,
        "status": item.status.value,
        "error_message": item.error_message,
        "thumbnail": item.thumbnail_data_url,
    }


def _job_to_json(job: Job) -> dict:
    payload = {
        "id": job.id,
        "status": job.status.value,
        "current": job.current,
        "total": job.total,
        "message": job.message,
        "warning": job.warning,
        "error": job.error,
    }
    if job.status == JobStatus.DONE and job.result is not None:
        result = job.result
        if isinstance(result, list):
            payload["files"] = [
                {"name": p.name, "url": f"/api/download/{job.id}/{p.name}"} for p in result
            ]
        else:
            payload["download_url"] = f"/api/download/{job.id}"
    return payload


# ---------- file upload / management ----------


@app.post("/api/upload")
async def upload_file(file: UploadFile):
    if not file_utils.is_allowed_extension(file.filename):
        raise HTTPException(400, detail=f"不支援的檔案格式：{file.filename}")

    data = await file.read()
    stored_path = file_utils.save_bytes_to_upload(data, file.filename)
    file_type = FileType.PDF if file_utils.guess_file_type(file.filename) == "pdf" else FileType.IMAGE

    item = FileItem(
        id=uuid.uuid4().hex,
        original_name=file.filename,
        stored_path=str(stored_path),
        file_type=file_type,
    )

    try:
        if file_type == FileType.PDF:
            page_count, thumb = file_utils.inspect_pdf(stored_path)
            item.page_count = page_count
            item.thumbnail_data_url = thumb
        else:
            item.thumbnail_data_url = file_utils.inspect_image(stored_path)
            item.page_count = 1
    except PdfEncryptedError:
        item.status = FileStatus.ENCRYPTED
        item.error_message = "PDF 有密碼保護，請輸入密碼"
    except (PdfCorruptedError, ImageCorruptedError) as exc:
        item.status = FileStatus.ERROR
        item.error_message = f"檔案無法開啟，可能已損毀：{exc}"

    store.add(item)

    return _file_item_to_json(item)


@app.post("/api/files/{file_id}/unlock")
def unlock_file(file_id: str, payload: PasswordPayload):
    item = store.get(file_id)
    if not item:
        raise HTTPException(404, detail="找不到檔案")

    try:
        page_count, thumb = file_utils.inspect_pdf(Path(item.stored_path), payload.password)
    except PdfEncryptedError as exc:
        raise HTTPException(400, detail=str(exc))

    item.page_count = page_count
    item.thumbnail_data_url = thumb
    item.status = FileStatus.OK
    item.error_message = None
    store.passwords[file_id] = payload.password

    return _file_item_to_json(item)


@app.delete("/api/files/{file_id}")
def delete_file(file_id: str):
    store.remove(file_id)
    return {"ok": True}


# ---------- merge ----------


@app.post("/api/merge")
def start_merge(options: MergeOptions):
    missing = [fid for fid in options.file_ids if fid not in store.files]
    if missing:
        raise HTTPException(400, detail=f"找不到檔案：{missing}")
    if not options.file_ids:
        raise HTTPException(400, detail="清單為空")

    all_items = [store.files[fid] for fid in options.file_ids]
    items = [i for i in all_items if i.status == FileStatus.OK]
    skipped = [i for i in all_items if i.status != FileStatus.OK]
    if not items:
        raise HTTPException(400, detail="沒有可合併的檔案（都尚未就緒或有錯誤）")

    output_name = options.output_name.strip() or "merged.pdf"
    if not output_name.lower().endswith(".pdf"):
        output_name += ".pdf"
    output_path = file_utils.new_output_path(output_name)

    job = job_manager.create()
    if skipped:
        names = "、".join(i.original_name for i in skipped)
        job.warning = f"已略過尚未就緒的檔案：{names}"

    file_ids = [i.id for i in items]
    store.mark_active(file_ids)

    def task(job: Job):
        try:
            return merger.merge_files(
                items,
                output_path,
                page_size=options.page_size,
                image_fit=options.image_fit,
                passwords=dict(store.passwords),
                progress_cb=job.progress_cb,
                cancel_check=job.cancel_check,
            )
        except merger.MergeError as exc:
            raise RuntimeError(f"{exc.file_name}：{exc.message}") from exc
        finally:
            store.unmark_active(file_ids)

    job_manager.run(job, task)
    return {"job_id": job.id}


# ---------- convert ----------


@app.post("/api/convert")
def start_convert(options: ConvertOptions):
    item = store.files.get(options.file_id)
    if not item:
        raise HTTPException(404, detail="找不到檔案")
    if item.file_type != FileType.PDF:
        raise HTTPException(400, detail="只能轉換 PDF 檔案")
    if item.status != FileStatus.OK:
        raise HTTPException(400, detail=item.error_message or "檔案尚未就緒")
    if not (72 <= options.dpi <= 600):
        raise HTTPException(400, detail="解析度需介於 72–600 DPI")

    try:
        page_indexes, skipped = converter.parse_page_range(options.page_range, item.page_count)
    except converter.PageRangeError as exc:
        raise HTTPException(400, detail=str(exc))

    raw_base_name = options.output_name.strip() or Path(item.original_name).stem
    base_name = file_utils.sanitize_filename(raw_base_name, fallback="converted")
    out_dir = file_utils.output_dir() / uuid.uuid4().hex
    job = job_manager.create()
    if skipped:
        job.warning = f"已略過不存在的頁碼：{', '.join(map(str, skipped))}"

    store.mark_active([item.id])

    def task(job: Job):
        try:
            return converter.convert_pdf(
                Path(item.stored_path),
                page_indexes,
                out_dir,
                base_name,
                fmt=options.format,
                dpi=options.dpi,
                jpg_quality=options.jpg_quality,
                pack_zip=options.pack_zip,
                password=store.passwords.get(item.id),
                progress_cb=job.progress_cb,
                cancel_check=job.cancel_check,
            )
        finally:
            store.unmark_active([item.id])

    job_manager.run(job, task)
    return {"job_id": job.id, "skipped_pages": skipped}


# ---------- jobs ----------


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(404, detail="找不到工作")
    return _job_to_json(job)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if not job_manager.cancel(job_id):
        raise HTTPException(404, detail="找不到工作")
    return {"ok": True}


@app.get("/api/download/{job_id}")
def download_result(job_id: str):
    job = job_manager.get(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, detail="檔案尚未準備好")
    result = job.result
    if isinstance(result, list):
        raise HTTPException(400, detail="請使用個別檔案下載連結")
    return FileResponse(result, filename=Path(result).name)


@app.get("/api/download/{job_id}/{filename}")
def download_one(job_id: str, filename: str):
    job = job_manager.get(job_id)
    if not job or job.status != JobStatus.DONE or not isinstance(job.result, list):
        raise HTTPException(404, detail="檔案尚未準備好")
    match = next((p for p in job.result if p.name == filename), None)
    if not match:
        raise HTTPException(404, detail="找不到檔案")
    return FileResponse(match, filename=match.name)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
