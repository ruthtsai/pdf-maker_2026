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


def make_image_pdf(path, pages=1, px=(1200, 1600), page_size=(216, 288)):
    """Pages each covered by a photo-like JPEG; at the default sizes the image is 400 DPI."""
    import io

    from PIL import Image

    noise = Image.effect_noise(px, 40).convert("RGB")
    gradient = Image.linear_gradient("L").resize(px).convert("RGB")
    buf = io.BytesIO()
    Image.blend(noise, gradient, 0.5).save(buf, "JPEG", quality=95)
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=page_size[0], height=page_size[1])
        page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(str(path))
    doc.close()
    return path


def image_sizes(path, password=None):
    """(width, height) of every image, page by page."""
    with fitz.open(path) as doc:
        if password:
            doc.authenticate(password)
        return [(img[2], img[3]) for page in doc for img in page.get_images(full=True)]
