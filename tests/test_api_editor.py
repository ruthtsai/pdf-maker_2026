import io
import time

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from core import file_utils
from tests.helpers import make_pdf, page_texts
from web import store
from web.server import app


@pytest.fixture
def client():
    return TestClient(app)


def upload(client, path, name=None):
    with open(path, "rb") as f:
        r = client.post("/api/upload", files={"file": (name or path.name, f, "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()


def run_job(client, job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def export(client, pages, name="edited.pdf"):
    r = client.post("/api/edit/export", json={"pages": pages, "output_name": name})
    assert r.status_code == 200, r.text
    job = run_job(client, r.json()["job_id"])
    return r.json(), job


def test_info_and_image_endpoints(client, tmp_path):
    item = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2"], size=(300, 400)))

    info = client.get(f"/api/files/{item['id']}/info").json()
    assert [(p["w"], p["h"]) for p in info["pages"]] == [(300, 400), (300, 400)]

    r = client.get(f"/api/files/{item['id']}/pages/1/image?w=150")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    pix = fitz.Pixmap(r.content)
    assert (pix.width, pix.height) == (150, 200)

    assert client.get(f"/api/files/{item['id']}/pages/9/image").status_code == 404
    assert client.get("/api/files/nope/info").status_code == 404


def test_image_is_cached_and_cleared_on_delete(client, tmp_path):
    item = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    client.get(f"/api/files/{item['id']}/pages/0/image?w=120")
    assert list(file_utils.thumb_dir().glob(f"{item['id']}_*"))
    client.delete(f"/api/files/{item['id']}")
    assert not list(file_utils.thumb_dir().glob(f"{item['id']}_*"))


def test_export_reorder_and_rotate(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2", "A3"]))
    body, job = export(
        client,
        [{"src": a["id"], "idx": 2, "rot": 90}, {"src": a["id"], "idx": 0, "rot": 0}],
    )
    assert job["status"] == "done", job
    assert body["page_count"] == 2
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)
    assert page_texts(out) == ["A3", "A1"]
    with fitz.open(out) as d:
        assert [p.rotation for p in d] == [90, 0]


def test_export_across_two_sources(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2"]))
    b = upload(client, make_pdf(tmp_path / "b.pdf", ["B1"]))
    _, job = export(
        client,
        [{"src": a["id"], "idx": 0}, {"src": b["id"], "idx": 0}, {"src": a["id"], "idx": 1}],
    )
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)
    assert page_texts(out) == ["A1", "B1", "A2"]


def test_export_validation_errors(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    r = client.post("/api/edit/export", json={"pages": [{"src": a["id"], "idx": 5}]})
    assert r.status_code == 400
    r = client.post("/api/edit/export", json={"pages": [{"src": "ghost", "idx": 0}]})
    assert r.status_code == 404
    r = client.post("/api/edit/export", json={"pages": []})
    assert r.status_code == 400


def test_export_filename_is_sanitized(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    _, job = export(client, [{"src": a["id"], "idx": 0}], name="../../evil.pdf")
    assert job["status"] == "done"
    assert ".." not in job["download_url"]
    assert store.files  # sanity: store populated by uploads


def test_encrypted_pdf_blocked_until_unlocked(client, tmp_path):
    plain = make_pdf(tmp_path / "p.pdf", ["S1", "S2"])
    enc = tmp_path / "enc.pdf"
    with fitz.open(plain) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")

    item = upload(client, enc)
    assert item["status"] == "encrypted"
    assert client.get(f"/api/files/{item['id']}/info").status_code == 403
    assert client.get(f"/api/files/{item['id']}/pages/0/image").status_code == 403
    r = client.post("/api/edit/export", json={"pages": [{"src": item["id"], "idx": 0}]})
    assert r.status_code == 403

    bad = client.post(f"/api/files/{item['id']}/unlock", json={"password": "nope"})
    assert bad.status_code == 400
    ok = client.post(f"/api/files/{item['id']}/unlock", json={"password": "pw"})
    assert ok.status_code == 200 and ok.json()["page_count"] == 2

    assert client.get(f"/api/files/{item['id']}/pages/0/image").status_code == 200
    _, job = export(client, [{"src": item["id"], "idx": 1}])
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)
    assert page_texts(out) == ["S2"]


def test_export_with_page_numbers_and_labels(client, tmp_path):
    import pypdf

    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2", "A3", "A4"]))
    pages = [{"src": a["id"], "idx": i} for i in range(4)]
    r = client.post(
        "/api/edit/export",
        json={
            "pages": pages,
            "output_name": "numbered.pdf",
            "page_labels": [{"start": 0, "style": "r"}, {"start": 2, "style": "D", "first": 1}],
            "page_numbers": {"fmt": "of", "start_page": 3, "start_number": 1, "v_pos": "top", "h_pos": "right"},
        },
    )
    assert r.status_code == 200, r.text
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)

    assert pypdf.PdfReader(str(out)).page_labels == ["i", "ii", "1", "2"]
    with fitz.open(out) as d:
        assert "第" not in d[1].get_text()
        assert "第 1 頁／共 2 頁" in d[2].get_text()
        assert "第 2 頁／共 2 頁" in d[3].get_text()


def test_preview_endpoint(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2"]))
    pages = [{"src": a["id"], "idx": 0}, {"src": a["id"], "idx": 1, "rot": 90}]

    plain = client.post("/api/edit/preview?index=1&w=400", json={"pages": pages})
    assert plain.status_code == 200 and plain.headers["content-type"] == "image/png"
    pix = fitz.Pixmap(plain.content)
    assert pix.width == 400 and pix.width > pix.height          # rotated page is landscape

    stamped = client.post(
        "/api/edit/preview?index=1&w=400", json={"pages": pages, "page_numbers": {"fmt": "number", "font_size": 20}}
    )
    assert stamped.status_code == 200 and stamped.content != plain.content

    assert client.post("/api/edit/preview?index=5", json={"pages": pages}).status_code == 404
    bad = client.post("/api/edit/preview?index=0", json={"pages": pages, "page_numbers": {"fmt": "nope"}})
    assert bad.status_code == 400


def _upload_png(client, tmp_path, name="stamp.png", color=(255, 0, 0, 255)):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGBA", (80, 40), color).save(path)
    with open(path, "rb") as f:
        r = client.post("/api/upload", files={"file": (name, f, "image/png")})
    assert r.status_code == 200, r.text
    return r.json()


def test_stamp_via_api_and_raw_image_endpoint(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1", "A2"]))
    stamp = _upload_png(client, tmp_path)

    raw = client.get(f"/api/files/{stamp['id']}/raw")
    assert raw.status_code == 200 and raw.content[:4] == b"\x89PNG"
    assert client.get(f"/api/files/{a['id']}/raw").status_code == 400      # a PDF is not an image

    body = {
        "pages": [{"src": a["id"], "idx": 0}, {"src": a["id"], "idx": 1}],
        "stamps": [{"file_id": stamp["id"], "cx": 0.5, "cy": 0.5, "w": 0.3, "pages": [1], "name": "red"}],
    }
    r = client.post("/api/edit/export", json={**body, "output_name": "stamped.pdf"})
    assert r.status_code == 200, r.text
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)
    with fitz.open(out) as d:
        assert len(d[0].get_images()) == 0
        assert len(d[1].get_images()) == 1

    prev = client.post("/api/edit/preview?index=1&w=300", json=body)
    assert prev.status_code == 200 and prev.content[:4] == b"\x89PNG"


def test_stamp_requires_an_image_file(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    r = client.post(
        "/api/edit/export",
        json={"pages": [{"src": a["id"], "idx": 0}], "stamps": [{"file_id": a["id"]}]},
    )
    assert r.status_code == 400
    r = client.post(
        "/api/edit/export",
        json={"pages": [{"src": a["id"], "idx": 0}], "stamps": [{"file_id": "ghost"}]},
    )
    assert r.status_code == 404
