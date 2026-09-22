"""PDF -> image conversion logic."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Callable

import pymupdf as fitz
from PIL import Image

from core.file_utils import PdfEncryptedError

ProgressCallback = Callable[[int, int, str], None]

_TOKEN_RE = re.compile(r"^\d+(-\d+)?$")


class PageRangeError(Exception):
    pass


def parse_page_range(range_str: str, total_pages: int) -> tuple[list[int], list[int]]:
    """Parses '1-5,8,10-12' (1-indexed, inclusive) into 0-indexed page numbers.

    Returns (sorted valid 0-indexed pages, sorted skipped 1-indexed page numbers
    that were out of range).
    """
    range_str = (range_str or "").strip()
    if not range_str:
        return list(range(total_pages)), []

    valid: set[int] = set()
    skipped: set[int] = set()

    for raw_token in range_str.split(","):
        token = raw_token.strip()
        if not token:
            continue
        if not _TOKEN_RE.match(token):
            raise PageRangeError(f"格式錯誤：「{token}」")

        if "-" in token:
            start_s, end_s = token.split("-")
            start, end = int(start_s), int(end_s)
            if start < 1 or end < start:
                raise PageRangeError(f"格式錯誤：「{token}」")
            for page_num in range(start, end + 1):
                if 1 <= page_num <= total_pages:
                    valid.add(page_num - 1)
                else:
                    skipped.add(page_num)
        else:
            page_num = int(token)
            if page_num < 1:
                raise PageRangeError(f"格式錯誤：「{token}」")
            if 1 <= page_num <= total_pages:
                valid.add(page_num - 1)
            else:
                skipped.add(page_num)

    if not valid:
        raise PageRangeError("沒有任何有效頁碼")

    return sorted(valid), sorted(skipped)


def convert_pdf(
    pdf_path: Path,
    page_indexes: list[int],
    output_dir: Path,
    base_name: str,
    fmt: str = "png",
    dpi: int = 200,
    jpg_quality: int = 90,
    pack_zip: bool = False,
    password: str | None = None,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path | list[Path]:
    """Converts the given 0-indexed pages of a PDF into image files.

    Returns a single zip Path if pack_zip else a list of individual image Paths.
    """
    doc = fitz.open(pdf_path)
    try:
        if doc.needs_pass:
            if not password or not doc.authenticate(password):
                raise PdfEncryptedError("PDF 有密碼保護或密碼錯誤")

        output_dir.mkdir(parents=True, exist_ok=True)
        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        ext = "jpg" if fmt == "jpg" else "png"
        total = len(page_indexes)
        image_paths: list[Path] = []

        for i, page_index in enumerate(page_indexes):
            if cancel_check and cancel_check():
                raise InterruptedError("cancelled")
            if progress_cb:
                progress_cb(i, total, f"第 {page_index + 1} 頁")

            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=matrix)
            out_path = output_dir / f"{base_name}_{page_index + 1}.{ext}"

            if fmt == "jpg":
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                img.save(out_path, format="JPEG", quality=jpg_quality)
            else:
                pix.save(out_path)

            image_paths.append(out_path)

        if progress_cb:
            progress_cb(total, total, "完成")

        if pack_zip:
            zip_path = output_dir / f"{base_name}.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for p in image_paths:
                    zf.write(p, arcname=p.name)
            for p in image_paths:
                p.unlink(missing_ok=True)
            return zip_path

        return image_paths
    finally:
        doc.close()
