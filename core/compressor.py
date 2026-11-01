"""Making a PDF smaller: lossless cleanup, optionally with downsampled, recompressed images."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pymupdf as fitz
from pymupdf import mupdf

from core.file_utils import PdfEncryptedError

ProgressCallback = Callable[[int, int, str], None]


@dataclass(frozen=True)
class ImageSettings:
    dpi: int
    jpeg_quality: int


# None: lossless cleanup only, images are left as they are.
LEVELS: dict[str, ImageSettings | None] = {
    "light": None,
    "standard": ImageSettings(dpi=150, jpeg_quality=75),
    "strong": ImageSettings(dpi=100, jpeg_quality=60),
}


def _rewrite_options(images: ImageSettings) -> mupdf.PdfImageRewriterOptions:
    """rewrite_images()'s own options subsample by powers of two, which can leave images at
    up to twice the target DPI; bicubic resampling reaches the target itself."""
    opts = mupdf.PdfImageRewriterOptions()
    for kind in ("color_lossless", "color_lossy", "gray_lossless", "gray_lossy", "bitonal"):
        method = mupdf.FZ_RECOMPRESS_FAX if kind == "bitonal" else mupdf.FZ_RECOMPRESS_JPEG
        setattr(opts, f"{kind}_image_recompress_method", method)
        setattr(opts, f"{kind}_image_recompress_quality", str(images.jpeg_quality))
        setattr(opts, f"{kind}_image_subsample_method", mupdf.FZ_SUBSAMPLE_BICUBIC)
        setattr(opts, f"{kind}_image_subsample_threshold", images.dpi + 1)
        setattr(opts, f"{kind}_image_subsample_to", images.dpi)
    return opts


class CompressError(ValueError):
    pass


@dataclass
class CompressResult:
    path: Path
    original_size: int
    compressed_size: int
    compressed: bool  # False: nothing could be saved, the output is a copy of the original

    @property
    def saved_ratio(self) -> float:
        return 1 - self.compressed_size / self.original_size if self.original_size else 0.0


def compress_pdf(
    pdf_path: Path,
    output_path: Path,
    level: str,
    password: str | None = None,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> CompressResult:
    """Writes a compressed copy of the PDF to output_path; the original is never changed.
    If the result would not be smaller, output_path gets an exact copy of the original.
    An encrypted PDF stays encrypted with the same password."""
    if level not in LEVELS:
        raise CompressError(f"未知的壓縮等級：{level}")
    images = LEVELS[level]
    steps = 2 if images else 1

    def step(i: int, message: str) -> None:
        if cancel_check and cancel_check():
            raise InterruptedError("cancelled")
        if progress_cb:
            progress_cb(i, steps, message)

    original_size = pdf_path.stat().st_size
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(output_path.name + ".part")

    doc = fitz.open(pdf_path)
    try:
        if doc.needs_pass and (not password or not doc.authenticate(password)):
            raise PdfEncryptedError("PDF 有密碼保護或密碼錯誤")
        n = 0
        if images:
            step(n, "壓縮影像")
            doc.rewrite_images(options=_rewrite_options(images))
            n += 1
        step(n, "整理並寫入")
        doc.save(str(temp_path), garbage=4, deflate=True, use_objstms=1, encryption=fitz.PDF_ENCRYPT_KEEP)
        step(n + 1, "完成")
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        doc.close()

    compressed_size = temp_path.stat().st_size
    if compressed_size >= original_size:
        temp_path.unlink()
        shutil.copyfile(pdf_path, output_path)
        return CompressResult(output_path, original_size, original_size, compressed=False)
    temp_path.replace(output_path)
    return CompressResult(output_path, original_size, compressed_size, compressed=True)
