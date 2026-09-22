"""Background job manager so long-running merge/convert work doesn't block requests
and can report progress + support cancellation, without a GUI event loop."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.PENDING
    current: int = 0
    total: int = 0
    message: str = ""
    warning: str | None = None
    error: str | None = None
    result: Any = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def progress_cb(self, current: int, total: int, message: str) -> None:
        self.current = current
        self.total = total
        self.message = message

    def cancel_check(self) -> bool:
        return self.cancel_event.is_set()


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self) -> Job:
        job = Job(id=uuid.uuid4().hex)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def run(self, job: Job, target: Callable[[Job], Any]) -> None:
        def _runner() -> None:
            job.status = JobStatus.RUNNING
            try:
                result = target(job)
                if job.cancel_event.is_set():
                    job.status = JobStatus.CANCELLED
                else:
                    job.result = result
                    job.status = JobStatus.DONE
            except InterruptedError:
                job.status = JobStatus.CANCELLED
            except Exception as exc:
                job.status = JobStatus.ERROR
                job.error = str(exc)

        threading.Thread(target=_runner, daemon=True).start()

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        job.cancel_event.set()
        return True


job_manager = JobManager()
