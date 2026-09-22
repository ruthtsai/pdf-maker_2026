"""File format validation, temp storage and thumbnail helpers."""

from __future__ import annotations

import atexit
import base64
import shutil
import tempfile
import uuid
from pathlib import Path

import pymupdf as fitz
import pypdf
from PIL import Image, UnidentifiedImageError

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}
THUMBNAIL_MAX_SIZE = (160, 160)

_TEMP_ROOT = Path(tempfile.mkdtemp(prefix="pdf_maker_"))
_UPLOAD_DIR = _TEMP_ROOT / "uploads"
_OUTPUT_DIR = _TEMP_ROOT / "outputs"
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _cleanup_temp_root() -> None:
    shutil.rmtree(_TEMP_ROOT, ignore_errors=True)


atexit.register(_cleanup_temp_root)


def upload_dir() -> Path:
    return _UPLOAD_DIR


def output_dir() -> Path:
    return _OUTPUT_DIR


def is_allowed_extension(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def guess_file_type(filename: str) -> str:
    return "pdf" if Path(filename).suffix.lower() == ".pdf" else "image"


def save_bytes_to_upload(data: bytes, original_name: str) -> Path:
    ext = Path(original_name).suffix.lower()
    dest = _UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
    dest.write_bytes(data)
    return dest


def new_output_path(filename: str) -> Path:
    """Returns a collision-free path inside the output temp dir."""
    dest = _OUTPUT_DIR / filename
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while True:
        candidate = _OUTPUT_DIR / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _image_to_data_url(img: Image.Image) -> str:
    img = img.convert("RGB")
    img.thumbnail(THUMBNAIL_MAX_SIZE)
    from io import BytesIO

    buf = BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


class PdfEncryptedError(Exception):
    pass


class PdfCorruptedError(Exception):
    pass


class ImageCorruptedError(Exception):
    pass


def inspect_pdf(path: Path, password: str | None = None) -> tuple[int, str]:
    """Returns (page_count, thumbnail_data_url). Raises PdfEncryptedError / PdfCorruptedError."""
    try:
        doc = fitz.open(path)
    except Exception as exc:  # corrupted / unreadable
        raise PdfCorruptedError(str(exc)) from exc

    try:
        if doc.needs_pass:
            if not password:
                raise PdfEncryptedError("PDF 有密碼保護")
            if not doc.authenticate(password):
                raise PdfEncryptedError("密碼錯誤")

        if doc.page_count == 0:
            raise PdfCorruptedError("PDF 沒有任何頁面")

        try:
            page = doc.load_page(0)
            pix = page.get_pixmap(matrix=fitz.Matrix(0.3, 0.3))
            thumb_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            thumb = _image_to_data_url(thumb_img)
        except Exception:
            thumb = None

        page_count = doc.page_count
        return page_count, thumb
    finally:
        doc.close()


def inspect_image(path: Path) -> str:
    """Returns thumbnail_data_url. Raises ImageCorruptedError."""
    try:
        with Image.open(path) as img:
            img.verify()
        with Image.open(path) as img:
            return _image_to_data_url(img)
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageCorruptedError(str(exc)) from exc


def decrypt_pdf_reader(path: Path, password: str | None) -> pypdf.PdfReader:
    reader = pypdf.PdfReader(str(path))
    if reader.is_encrypted:
        if not password:
            raise PdfEncryptedError("PDF 有密碼保護")
        result = reader.decrypt(password)
        if result == 0:
            raise PdfEncryptedError("密碼錯誤")
    return reader
