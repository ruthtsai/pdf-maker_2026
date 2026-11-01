"""HTTP side of file lifetime: heartbeat, idle sweep and deletion."""

import pytest
from fastapi.testclient import TestClient

from tests.helpers import make_pdf
from tests.test_api_editor import run_job, upload
from tests.test_store import FakeClock
from web import store
from web.server import app
from web.store import UPLOAD_TTL_SECONDS


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock(store.default.clock())
    monkeypatch.setattr(store.default, "clock", fake)
    return fake


def test_heartbeat_keeps_an_idle_file_alive(client, clock, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    b = upload(client, make_pdf(tmp_path / "b.pdf", ["B1"]))
    for _ in range(3):
        clock.advance(UPLOAD_TTL_SECONDS - 60)
        r = client.post("/api/files/heartbeat", json={"file_ids": [a["id"]]})
        assert r.status_code == 200
        store.sweep()

    assert client.get(f"/api/files/{a['id']}/info").status_code == 200
    assert client.get(f"/api/files/{b['id']}/info").status_code == 404
    r = client.post("/api/files/heartbeat", json={"file_ids": [a["id"], b["id"]]})
    assert r.json() == {"missing": [b["id"]]}


def test_starting_a_convert_counts_as_activity(client, clock, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    clock.advance(UPLOAD_TTL_SECONDS - 60)
    r = client.post("/api/convert", json={"file_id": a["id"], "dpi": 72})
    assert r.status_code == 200, r.text
    assert run_job(client, r.json()["job_id"])["status"] == "done"
    clock.advance(UPLOAD_TTL_SECONDS - 60)
    store.sweep()
    assert client.post("/api/files/heartbeat", json={"file_ids": [a["id"]]}).json() == {"missing": []}


def test_starting_a_merge_counts_as_activity(client, clock, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    clock.advance(UPLOAD_TTL_SECONDS - 60)
    r = client.post("/api/merge", json={"file_ids": [a["id"]]})
    assert r.status_code == 200, r.text
    assert run_job(client, r.json()["job_id"])["status"] == "done"
    clock.advance(UPLOAD_TTL_SECONDS - 60)
    store.sweep()
    assert client.post("/api/files/heartbeat", json={"file_ids": [a["id"]]}).json() == {"missing": []}


def test_a_deleted_file_is_gone(client, tmp_path):
    a = upload(client, make_pdf(tmp_path / "a.pdf", ["A1"]))
    assert client.delete(f"/api/files/{a['id']}").status_code == 200
    assert client.post("/api/files/heartbeat", json={"file_ids": [a["id"]]}).json() == {"missing": [a["id"]]}
    assert client.get(f"/api/files/{a['id']}/info").status_code == 404
