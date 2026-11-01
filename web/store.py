"""The registry of uploaded files and the single owner of their lifetime.

One rule: a file is not removed while an Edit Session keeps it alive (by using it or
sending heartbeats) or while a running job holds it. Everything else that sits idle
longer than UPLOAD_TTL_SECONDS is swept away.
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from pathlib import Path
from typing import Callable, Iterable

from core import file_utils
from models.file_item import FileItem

UPLOAD_TTL_SECONDS = 30 * 60
_SWEEP_INTERVAL_SECONDS = 5 * 60

Clock = Callable[[], float]


class Hold:
    """A job's claim on some files. Releasing it twice only releases it once."""

    def __init__(self, store: FileStore, file_ids: list[str]):
        self._store = store
        self._file_ids = file_ids
        self._released = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._store._release(self._file_ids)


class FileStore:
    def __init__(self, clock: Clock = time.time, ttl: float = UPLOAD_TTL_SECONDS):
        self.clock = clock
        self.ttl = ttl
        self._items: dict[str, FileItem] = {}
        self._passwords: dict[str, str] = {}
        self._holds: Counter[str] = Counter()
        self._removed: dict[str, FileItem] = {}  # removed while held; deleted on last release
        self._lock = threading.RLock()

    def add(self, item: FileItem) -> None:
        with self._lock:
            item.touched_at = self.clock()
            self._items[item.id] = item

    def get(self, file_id: str) -> FileItem | None:
        """Looks a file up and counts the lookup as activity."""
        with self._lock:
            item = self._items.get(file_id)
            if item:
                item.touched_at = self.clock()
            return item

    def heartbeat(self, file_ids: Iterable[str]) -> list[str]:
        """Marks the files as in use; returns the ones that no longer exist."""
        return [fid for fid in file_ids if self.get(fid) is None]

    def password(self, file_id: str) -> str | None:
        return self._passwords.get(file_id)

    def set_password(self, file_id: str, password: str) -> None:
        with self._lock:
            if file_id in self._items:
                self._passwords[file_id] = password

    def hold(self, file_ids: Iterable[str]) -> Hold:
        """Keeps the files until the returned Hold is released. Raises KeyError if any is missing."""
        file_ids = list(dict.fromkeys(file_ids))
        with self._lock:
            missing = [fid for fid in file_ids if fid not in self._items]
            if missing:
                raise KeyError(missing)
            now = self.clock()
            for fid in file_ids:
                self._holds[fid] += 1
                self._items[fid].touched_at = now
        return Hold(self, file_ids)

    def _release(self, file_ids: list[str]) -> None:
        with self._lock:
            now = self.clock()
            for fid in file_ids:
                self._holds[fid] -= 1
                if self._holds[fid] > 0:
                    continue
                del self._holds[fid]
                if fid in self._removed:
                    self._delete(self._removed.pop(fid))
                elif fid in self._items:
                    self._items[fid].touched_at = now

    def remove(self, file_id: str) -> None:
        """Removes a file now, or once the last job holding it has finished."""
        with self._lock:
            item = self._items.pop(file_id, None)
            self._passwords.pop(file_id, None)
            if item is None:
                return
            if self._holds[file_id] > 0:
                self._removed[file_id] = item
            else:
                self._holds.pop(file_id, None)
                self._delete(item)

    def sweep(self) -> None:
        """Removes every file that is neither held nor used within the TTL."""
        with self._lock:
            now = self.clock()
            stale = [
                fid
                for fid, item in self._items.items()
                if self._holds[fid] <= 0 and now - item.touched_at > self.ttl
            ]
            for fid in stale:
                self.remove(fid)

    @staticmethod
    def _delete(item: FileItem) -> None:
        file_utils.remove_thumbs(item.id)
        Path(item.stored_path).unlink(missing_ok=True)


default = FileStore()

add = default.add
get = default.get
heartbeat = default.heartbeat
password = default.password
set_password = default.set_password
hold = default.hold
remove = default.remove
sweep = default.sweep


def _sweep_loop() -> None:
    while True:
        time.sleep(_SWEEP_INTERVAL_SECONDS)
        try:
            default.sweep()
        except Exception:
            pass


threading.Thread(target=_sweep_loop, daemon=True).start()
