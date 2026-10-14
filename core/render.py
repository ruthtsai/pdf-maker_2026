"""Page rendering + document inspection for the page editor (thumbnails, previews, TOC)."""

from __future__ import annotations

from pathlib import Path

import pymupdf as fitz

from core import file_utils
from core.file_utils import PdfEncryptedError

MIN_WIDTH, MAX_WIDTH = 40, 2400


def _open(path: Path, password: str | None) -> fitz.Document:
    doc = fitz.open(path)
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            raise PdfEncryptedError("PDF 有密碼保護或密碼錯誤")
    return doc


def open_document(path: Path, password: str | None = None) -> fitz.Document:
    return _open(path, password)


def _decode_label_prefix(prefix: str) -> str:
    """PyMuPDF hands back hex text strings ("<FEFF...>") undecoded."""
    if prefix.startswith("<") and prefix.endswith(">"):
        try:
            return bytes.fromhex(prefix[1:-1]).decode("utf-16")
        except (ValueError, UnicodeError):
            return prefix
    return prefix


def inspect_document(path: Path, password: str | None = None) -> dict:
    """Per-page visual size (after the page's own /Rotate), bookmarks, and page labels."""
    doc = _open(path, password)
    try:
        pages = [
            {"w": round(p.rect.width, 2), "h": round(p.rect.height, 2), "rotation": p.rotation}
            for p in doc
        ]
        toc = [{"level": lvl, "title": title, "page": page} for lvl, title, page, *_ in doc.get_toc(simple=True)]
        labels = [
            {**rule, "prefix": _decode_label_prefix(rule.get("prefix", ""))} for rule in (doc.get_page_labels() or [])
        ]
        return {"pages": pages, "toc": toc, "labels": labels}
    finally:
        doc.close()


def render_page(
    file_id: str,
    path: Path,
    page_index: int,
    width: int,
    password: str | None = None,
    fmt: str = "jpeg",
) -> bytes:
    """Renders one page scaled to `width` pixels wide, cached on disk per (file, page, width)."""
    width = max(MIN_WIDTH, min(MAX_WIDTH, int(width)))
    ext = "png" if fmt == "png" else "jpg"
    cache = file_utils.thumb_dir() / f"{file_id}_{page_index}_{width}.{ext}"
    if cache.exists():
        return cache.read_bytes()

    doc = _open(path, password)
    try:
        if not 0 <= page_index < doc.page_count:
            raise IndexError(f"page {page_index} out of range (0..{doc.page_count - 1})")
        page = doc.load_page(page_index)
        zoom = width / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False)
        data = pix.tobytes("png") if fmt == "png" else pix.tobytes("jpeg", jpg_quality=82)
    finally:
        doc.close()

    cache.write_bytes(data)
    return data
