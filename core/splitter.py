"""Splitting one PDF into several, by page ranges or every N pages."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Callable

import pymupdf as fitz

from core.converter import PageRangeError, parse_page_range
from core.file_utils import PdfEncryptedError

ProgressCallback = Callable[[int, int, str], None]


class SplitError(ValueError):
    pass


def groups_by_ranges(spec: str, total_pages: int) -> list[list[int]]:
    """'1-3;4;5-8' -> one group of 0-based pages per ';'-separated range. Each range uses the
    page-range syntax of the convert tab, so '1,3' is also one group."""
    segments = [seg.strip() for seg in (spec or "").split(";") if seg.strip()]
    if not segments:
        raise SplitError("請輸入頁碼範圍，例如 1-3;4;5-8")
    groups = []
    for n, seg in enumerate(segments, start=1):
        try:
            pages, skipped = parse_page_range(seg, total_pages)
        except PageRangeError as exc:
            raise SplitError(f"第 {n} 組「{seg}」：{exc}（共 {total_pages} 頁）") from exc
        if skipped:
            raise SplitError(f"第 {skipped[0]} 頁超出範圍（共 {total_pages} 頁）")
        groups.append(pages)
    return groups


def groups_every(n: int, total_pages: int) -> list[list[int]]:
    if n < 1:
        raise SplitError("每份頁數需大於等於 1")
    return [list(range(i, min(i + n, total_pages))) for i in range(0, total_pages, n)]


def part_name(base_name: str, pages: list[int]) -> str:
    first, last = pages[0] + 1, pages[-1] + 1
    return f"{base_name}_{first}.pdf" if first == last else f"{base_name}_{first}-{last}.pdf"


def _unique(name: str, taken: set[str]) -> str:
    stem, candidate, k = name[:-4], name, 1
    while candidate in taken:
        k += 1
        candidate = f"{stem}_{k}.pdf"
    taken.add(candidate)
    return candidate


def split_pdf(
    pdf_path: Path,
    groups: list[list[int]],
    output_dir: Path,
    base_name: str,
    password: str | None = None,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Writes one PDF per group of 0-based pages. Returns that PDF when there is one group,
    otherwise a zip of all of them."""
    doc = fitz.open(pdf_path)
    try:
        if doc.needs_pass and (not password or not doc.authenticate(password)):
            raise PdfEncryptedError("PDF 有密碼保護或密碼錯誤")

        output_dir.mkdir(parents=True, exist_ok=True)
        total = len(groups)
        taken: set[str] = set()
        parts: list[Path] = []
        for i, pages in enumerate(groups):
            if cancel_check and cancel_check():
                raise InterruptedError("cancelled")
            name = _unique(part_name(base_name, pages), taken)
            if progress_cb:
                progress_cb(i, total, name)
            part = fitz.open()
            try:
                for page in pages:
                    part.insert_pdf(doc, from_page=page, to_page=page)
                out = output_dir / name
                part.save(str(out), garbage=3, deflate=True)
            finally:
                part.close()
            parts.append(out)

        if progress_cb:
            progress_cb(total, total, "完成")
        if len(parts) == 1:
            return parts[0]

        zip_path = output_dir / f"{base_name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in parts:
                zf.write(p, arcname=p.name)
        for p in parts:
            p.unlink(missing_ok=True)
        return zip_path
    finally:
        doc.close()
