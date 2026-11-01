import io
import zipfile

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from tests.helpers import make_pdf, page_texts
from tests.test_api_editor import run_job, upload
from web.server import app


@pytest.fixture
def client():
    return TestClient(app)


def test_split_by_ranges_downloads_a_zip(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "report.pdf", ["P1", "P2", "P3", "P4"]))
    r = client.post("/api/split", json={"file_id": a["id"], "mode": "ranges", "ranges": "1-2;3-4"})
    assert r.status_code == 200, r.text
    assert r.json()["parts"] == 2
    assert r.json()["file_name"] == "report.zip"

    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
    data = client.get(job["download_url"]).content
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert zf.namelist() == ["report_1-2.pdf", "report_3-4.pdf"]


def test_split_into_one_part_downloads_the_pdf(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "report.pdf", ["P1", "P2", "P3"]))
    r = client.post("/api/split", json={"file_id": a["id"], "mode": "every", "every": 5})
    assert r.status_code == 200, r.text
    assert r.json()["file_name"] == "report_1-3.pdf"
    job = run_job(client, r.json()["job_id"])
    out = tmp_path / "dl.pdf"
    out.write_bytes(client.get(job["download_url"]).content)
    assert page_texts(out) == ["P1", "P2", "P3"]


def test_bad_page_numbers_are_a_400(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["P1", "P2"]))
    for body in (
        {"mode": "ranges", "ranges": "1;5"},
        {"mode": "ranges", "ranges": "x"},
        {"mode": "ranges", "ranges": ""},
        {"mode": "every", "every": 0},
    ):
        r = client.post("/api/split", json={"file_id": a["id"], **body})
        assert r.status_code == 400, body
        assert r.json()["detail"]


def test_an_unknown_file_is_a_404(client):
    r = client.post("/api/split", json={"file_id": "ghost", "mode": "every", "every": 1})
    assert r.status_code == 404


def test_an_encrypted_file_is_split_after_unlocking(client, tmp_path):
    plain = make_pdf(tmp_path / "p.pdf", ["S1", "S2"])
    enc = tmp_path / "enc.pdf"
    with fitz.open(plain) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    item = upload(client, enc)

    r = client.post("/api/split", json={"file_id": item["id"], "mode": "every", "every": 1})
    assert r.status_code == 400
    client.post(f"/api/files/{item['id']}/unlock", json={"password": "pw"})
    r = client.post("/api/split", json={"file_id": item["id"], "mode": "every", "every": 1})
    job = run_job(client, r.json()["job_id"])
    assert job["status"] == "done", job
