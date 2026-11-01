import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from tests.helpers import image_sizes, make_image_pdf, make_pdf
from tests.test_api_editor import run_job, upload
from tests.test_compressor import already_compressed_pdf
from web.server import app


@pytest.fixture
def client():
    return TestClient(app)


def test_compress_reports_sizes_and_downloads_a_smaller_copy(client, tmp_path):
    src = make_image_pdf(tmp_path / "scan.pdf")
    a = upload(client, src)
    r = client.post("/api/compress", json={"file_id": a["id"], "level": "standard"})
    assert r.status_code == 200, r.text
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["download_url"]
    details = job["details"]
    assert details["original_size"] == src.stat().st_size
    assert details["compressed_size"] < details["original_size"]
    assert 0 < details["saved_ratio"] < 1
    assert details["compressed"] is True
    assert not job["warning"]

    dl = client.get(job["download_url"])
    assert 'filename="scan_compressed.pdf"' in dl.headers["content-disposition"]
    out = tmp_path / "dl.pdf"
    out.write_bytes(dl.content)
    assert len(dl.content) == details["compressed_size"]
    assert image_sizes(out)[0][0] < 1200


def test_a_file_that_cannot_shrink_comes_back_as_a_copy_with_a_warning(client, tmp_path):
    clean = already_compressed_pdf(tmp_path)
    a = upload(client, clean)
    r = client.post("/api/compress", json={"file_id": a["id"], "level": "strong"})
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["details"]["compressed"] is False
    assert "這份檔案已無法再壓縮" in job["warning"]
    assert client.get(job["download_url"]).content == clean.read_bytes()


def test_bad_requests(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    assert client.post("/api/compress", json={"file_id": a["id"], "level": "extreme"}).status_code == 422
    assert client.post("/api/compress", json={"file_id": "ghost", "level": "light"}).status_code == 404


def test_an_encrypted_file_is_compressed_after_unlocking(client, tmp_path):
    plain = make_image_pdf(tmp_path / "p.pdf")
    enc = tmp_path / "enc.pdf"
    with fitz.open(plain) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    item = upload(client, enc)
    assert client.post("/api/compress", json={"file_id": item["id"], "level": "light"}).status_code == 400
    client.post(f"/api/files/{item['id']}/unlock", json={"password": "pw"})
    r = client.post("/api/compress", json={"file_id": item["id"], "level": "standard"})
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["details"]["compressed"] is True
