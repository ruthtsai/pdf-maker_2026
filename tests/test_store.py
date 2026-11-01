"""File lifetime: a file is kept while an Edit Session keeps it alive or a job holds it."""

import pytest

from models.file_item import FileItem, FileType
from web.store import FileStore, UPLOAD_TTL_SECONDS


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def store(clock):
    return FileStore(clock=clock)


def add_file(store, tmp_path, file_id="a"):
    path = tmp_path / f"{file_id}.pdf"
    path.write_bytes(b"%PDF-1.4")
    store.add(FileItem(id=file_id, original_name=f"{file_id}.pdf", stored_path=str(path), file_type=FileType.PDF))
    return path


def test_an_idle_file_is_swept_after_the_ttl(store, clock, tmp_path):
    path = add_file(store, tmp_path)
    clock.advance(UPLOAD_TTL_SECONDS - 1)
    store.sweep()
    assert store.get("a") is not None

    clock.advance(UPLOAD_TTL_SECONDS + 1)
    store.sweep()
    assert store.get("a") is None
    assert not path.exists()


def test_a_lookup_counts_as_activity(store, clock, tmp_path):
    add_file(store, tmp_path)
    clock.advance(UPLOAD_TTL_SECONDS - 10)
    store.get("a")
    clock.advance(UPLOAD_TTL_SECONDS - 10)
    store.sweep()
    assert store.get("a") is not None


def test_heartbeat_extends_life_and_reports_missing_files(store, clock, tmp_path):
    add_file(store, tmp_path, "a")
    add_file(store, tmp_path, "b")
    for _ in range(4):
        clock.advance(UPLOAD_TTL_SECONDS - 60)
        assert store.heartbeat(["a", "gone"]) == ["gone"]
        store.sweep()
    assert store.get("a") is not None
    assert store.get("b") is None
    assert store.heartbeat(["a", "b"]) == ["b"]


def test_a_held_file_is_not_swept(store, clock, tmp_path):
    add_file(store, tmp_path)
    hold = store.hold(["a"])
    clock.advance(UPLOAD_TTL_SECONDS * 3)
    store.sweep()
    assert store.get("a") is not None
    hold.release()
    clock.advance(1)
    store.sweep()
    assert store.get("a") is not None  # releasing counts as activity
    clock.advance(UPLOAD_TTL_SECONDS + 1)
    store.sweep()
    assert store.get("a") is None


def test_holds_are_counted(store, clock, tmp_path):
    add_file(store, tmp_path)
    first = store.hold(["a"])
    second = store.hold(["a"])
    first.release()
    clock.advance(UPLOAD_TTL_SECONDS * 3)
    store.sweep()
    assert store.get("a") is not None
    second.release()
    clock.advance(UPLOAD_TTL_SECONDS + 1)
    store.sweep()
    assert store.get("a") is None


def test_releasing_a_hold_twice_does_not_release_another_jobs_hold(store, clock, tmp_path):
    add_file(store, tmp_path)
    first = store.hold(["a"])
    store.hold(["a"])
    first.release()
    first.release()
    clock.advance(UPLOAD_TTL_SECONDS * 3)
    store.sweep()
    assert store.get("a") is not None


def test_removing_a_held_file_waits_for_the_last_hold(store, tmp_path):
    path = add_file(store, tmp_path)
    first = store.hold(["a"])
    second = store.hold(["a"])
    store.remove("a")
    assert store.get("a") is None  # gone for new requests at once
    assert path.exists()  # but still on disk for the running jobs
    first.release()
    assert path.exists()
    second.release()
    assert not path.exists()


def test_removing_an_unheld_file_deletes_it_at_once(store, tmp_path):
    path = add_file(store, tmp_path)
    store.set_password("a", "pw")
    store.remove("a")
    assert store.get("a") is None
    assert store.password("a") is None
    assert not path.exists()


def test_a_missing_file_cannot_be_held(store, tmp_path):
    add_file(store, tmp_path)
    with pytest.raises(KeyError):
        store.hold(["a", "nope"])
    store.remove("a")  # the failed hold left nothing behind
    assert not (tmp_path / "a.pdf").exists()


def test_a_removed_file_is_missing_for_heartbeat_and_holds(store, tmp_path):
    add_file(store, tmp_path)
    hold = store.hold(["a"])
    store.remove("a")
    assert store.heartbeat(["a"]) == ["a"]
    with pytest.raises(KeyError):
        store.hold(["a"])
    hold.release()
