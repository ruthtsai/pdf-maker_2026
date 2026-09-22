from dataclasses import dataclass, field
from enum import Enum


class FileType(str, Enum):
    PDF = "pdf"
    IMAGE = "image"


class FileStatus(str, Enum):
    OK = "ok"
    ENCRYPTED = "encrypted"
    ERROR = "error"


@dataclass
class FileItem:
    """Represents one uploaded file. UI (web layer) and core talk only through this object."""

    id: str
    original_name: str
    stored_path: str
    file_type: FileType
    page_count: int = 1
    status: FileStatus = FileStatus.OK
    error_message: str | None = None
    thumbnail_data_url: str | None = None
