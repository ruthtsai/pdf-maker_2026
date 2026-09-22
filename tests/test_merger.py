import fitz
import pypdf
from PIL import Image

from core.merger import merge_files
from models.file_item import FileItem, FileType


def _make_pdf(path, page_count=2):
    doc = fitz.open()
    for _ in range(page_count):
        doc.new_page(width=200, height=200)
    doc.save(str(path))
    doc.close()


def _make_image(path, size=(100, 150)):
    Image.new("RGB", size, color="white").save(path)


def test_merge_pdf_and_image_original_size(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    img_path = tmp_path / "b.png"
    _make_pdf(pdf_path, page_count=2)
    _make_image(img_path)

    items = [
        FileItem(id="1", original_name="a.pdf", stored_path=str(pdf_path), file_type=FileType.PDF, page_count=2),
        FileItem(id="2", original_name="b.png", stored_path=str(img_path), file_type=FileType.IMAGE, page_count=1),
    ]

    out_path = tmp_path / "out.pdf"
    result = merge_files(items, out_path, page_size="original")

    reader = pypdf.PdfReader(str(result))
    assert len(reader.pages) == 3


def test_merge_respects_order(tmp_path):
    pdf1 = tmp_path / "a.pdf"
    pdf2 = tmp_path / "b.pdf"
    _make_pdf(pdf1, page_count=1)
    _make_pdf(pdf2, page_count=3)

    items = [
        FileItem(id="2", original_name="b.pdf", stored_path=str(pdf2), file_type=FileType.PDF, page_count=3),
        FileItem(id="1", original_name="a.pdf", stored_path=str(pdf1), file_type=FileType.PDF, page_count=1),
    ]

    out_path = tmp_path / "out.pdf"
    result = merge_files(items, out_path)

    reader = pypdf.PdfReader(str(result))
    assert len(reader.pages) == 4


def test_merge_with_a4_layout(tmp_path):
    img_path = tmp_path / "img.png"
    _make_image(img_path, size=(300, 200))

    items = [
        FileItem(id="1", original_name="img.png", stored_path=str(img_path), file_type=FileType.IMAGE, page_count=1),
    ]

    out_path = tmp_path / "out.pdf"
    result = merge_files(items, out_path, page_size="a4", image_fit="center")

    reader = pypdf.PdfReader(str(result))
    assert len(reader.pages) == 1


def test_progress_callback_invoked(tmp_path):
    pdf_path = tmp_path / "a.pdf"
    _make_pdf(pdf_path, page_count=1)
    items = [
        FileItem(id="1", original_name="a.pdf", stored_path=str(pdf_path), file_type=FileType.PDF, page_count=1),
    ]

    calls = []
    merge_files(items, tmp_path / "out.pdf", progress_cb=lambda cur, total, msg: calls.append((cur, total, msg)))
    assert len(calls) >= 1
