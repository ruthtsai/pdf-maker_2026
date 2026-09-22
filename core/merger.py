"""Merge logic: image-to-page conversion + PDF page concatenation."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Callable, Iterable

import img2pdf
import pypdf
from PIL import Image

from core.file_utils import PdfEncryptedError, decrypt_pdf_reader
from models.file_item import FileItem, FileType

A4_WIDTH_MM = 210
A4_HEIGHT_MM = 297

ProgressCallback = Callable[[int, int, str], None]


class MergeError(Exception):
    def __init__(self, file_name: str, message: str):
        super().__init__(f"{file_name}: {message}")
        self.file_name = file_name
        self.message = message


def _build_layout_fun(page_size: str, image_fit: str):
    if page_size != "a4":
        return img2pdf.default_layout_fun
    pagesize = (img2pdf.mm_to_pt(A4_WIDTH_MM), img2pdf.mm_to_pt(A4_HEIGHT_MM))
    fit_mode = img2pdf.FitMode.fill if image_fit == "fill" else img2pdf.FitMode.into
    return img2pdf.get_layout_fun(pagesize=pagesize, fit=fit_mode)


def _image_bytes_for_merge(path: Path) -> bytes:
    # Re-encode through Pillow to normalize color mode and catch corrupted images early.
    with Image.open(path) as img:
        img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95)
        return buf.getvalue()


def merge_files(
    items: Iterable[FileItem],
    output_path: Path,
    page_size: str = "original",
    image_fit: str = "center",
    passwords: dict[str, str] | None = None,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Merges PDF and image FileItems, in the given order, into one PDF file."""
    items = list(items)
    passwords = passwords or {}
    writer = pypdf.PdfWriter()
    layout_fun = _build_layout_fun(page_size, image_fit)

    total = len(items)
    for index, item in enumerate(items, start=1):
        if cancel_check and cancel_check():
            raise InterruptedError("cancelled")

        if progress_cb:
            progress_cb(index - 1, total, item.original_name)

        try:
            if item.file_type == FileType.PDF:
                reader = decrypt_pdf_reader(Path(item.stored_path), passwords.get(item.id))
                for page in reader.pages:
                    writer.add_page(page)
            else:
                img_bytes = _image_bytes_for_merge(Path(item.stored_path))
                pdf_bytes = img2pdf.convert([img_bytes], layout_fun=layout_fun)
                page_reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
                for page in page_reader.pages:
                    writer.add_page(page)
        except PdfEncryptedError as exc:
            raise MergeError(item.original_name, str(exc)) from exc
        except MergeError:
            raise
        except Exception as exc:
            raise MergeError(item.original_name, f"無法讀取檔案（可能已損毀）：{exc}") from exc

    if progress_cb:
        progress_cb(total, total, "寫入輸出檔案")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        writer.write(f)

    return output_path
