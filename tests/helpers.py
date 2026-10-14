import pymupdf as fitz


def make_pdf(path, labels, size=(300, 400)):
    """One page per label; the label is written as page text so tests can identify pages."""
    doc = fitz.open()
    for label in labels:
        page = doc.new_page(width=size[0], height=size[1])
        page.insert_text((40, 80), label, fontsize=24)
    doc.save(str(path))
    doc.close()
    return path


def page_texts(path):
    with fitz.open(path) as doc:
        return [p.get_text().strip() for p in doc]


def page_rotations(path):
    with fitz.open(path) as doc:
        return [p.rotation for p in doc]
