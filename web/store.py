"""In-memory registry of uploaded files, shared by every route module."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from core import file_utils
from models.file_item import FileItem

files: dict[str, FileItem] = {}
passwords: dict[str, str] = {}
store_lock = threading.Lock()

# An uploaded file that sits unused (tab left open, never merged/converted) would
# otherwise only be cleaned up when the whole process exits. Sweep it away after
# it's been idle this long, unless a job is actively reading it.
UPLOAD_TTL_SECONDS = 30 * 60
_CLEANUP_INTERVAL_SECONDS = 5 * 60

_active_file_ids: set[str] = set()
_active_lock = threading.Lock()


def mark_active(file_ids: list[str]) -> None:
    with _active_lock:
        _active_file_ids.update(file_ids)


def unmark_active(file_ids: list[str]) -> None:
    with _active_lock:
        _active_file_ids.difference_update(file_ids)


def add(item: FileItem) -> None:
    with store_lock:
        files[item.id] = item


def get(file_id: str) -> FileItem | None:
    """Looks a file up and counts the lookup as activity so the idle sweep spares it."""
    item = files.get(file_id)
    if item:
        item.touched_at = time.time()
    return item


def remove(file_id: str) -> None:
    item = files.pop(file_id, None)
    passwords.pop(file_id, None)
    file_utils.remove_thumbs(file_id)
    if item:
        Path(item.stored_path).unlink(missing_ok=True)


def cleanup_stale_uploads() -> None:
    now = time.time()
    with store_lock, _active_lock:
        stale_ids = [
            fid
            for fid, item in files.items()
            if fid not in _active_file_ids and (now - item.touched_at) > UPLOAD_TTL_SECONDS
        ]
        for fid in stale_ids:
            remove(fid)


def _cleanup_loop() -> None:
    while True:
        time.sleep(_CLEANUP_INTERVAL_SECONDS)
        try:
            cleanup_stale_uploads()
        except Exception:
            pass


threading.Thread(target=_cleanup_loop, daemon=True).start()
