"""AcroForm detection, filling and flattening."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pymupdf as fitz

from core.file_utils import PdfEncryptedError

ProgressCallback = Callable[[int, int, str], None]

_TYPE_NAMES = {
    fitz.PDF_WIDGET_TYPE_TEXT: "text",
    fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
    fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio",
    fitz.PDF_WIDGET_TYPE_COMBOBOX: "combobox",
    fitz.PDF_WIDGET_TYPE_LISTBOX: "listbox",
    fitz.PDF_WIDGET_TYPE_BUTTON: "button",
    fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
}
_FILLABLE = {"text", "checkbox", "radio", "combobox", "listbox"}

_FLAG_READONLY = 1
_FLAG_MULTILINE = 1 << 12
_FLAG_PASSWORD = 1 << 13


class FormError(ValueError):
    pass


def _open(path: Path, password: str | None) -> fitz.Document:
    doc = fitz.open(path)
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            raise PdfEncryptedError("PDF 有密碼保護或密碼錯誤")
    return doc


def _has_xfa(doc: fitz.Document) -> bool:
    try:
        kind, _ = doc.xref_get_key(doc.pdf_catalog(), "AcroForm/XFA")
        return kind != "null"
    except Exception:
        return False


def _pdf_name(name: str) -> str:
    """A PDF name object: anything outside the regular printable range is #-escaped."""
    out = []
    for ch in name:
        if ch.isascii() and ch.isalnum() or ch in "-_.":
            out.append(ch)
        else:
            out.extend(f"#{b:02X}" for b in ch.encode("utf-8"))
    return "/" + "".join(out)


def _set_radio(doc: fitz.Document, widget: fitz.Widget, chosen: str) -> None:
    """The chosen button is switched on with widget.update() (which also draws its appearance
    when the file has none). Switching buttons *off* is written straight to the PDF because
    update() is unreliable at that: asked to turn a radio button off it can select a sibling."""
    on_state = widget.on_state()
    if chosen and on_state == chosen:
        widget.field_value = chosen
        widget.update()
        return
    kind, value = doc.xref_get_key(widget.xref, "Parent")
    group = int(value.split()[0]) if kind == "xref" else widget.xref
    doc.xref_set_key(group, "V", _pdf_name(chosen) if chosen else "/Off")
    doc.xref_set_key(widget.xref, "AS", "/Off")


def _is_checked(widget: fitz.Widget) -> bool:
    return str(widget.field_value) not in ("", "Off", "False", "0")


def detect_fields(path: Path, password: str | None = None) -> dict:
    """Fields with their position in each page's *visual* frame (rotation applied)."""
    doc = _open(path, password)
    try:
        pages = [{"w": round(p.rect.width, 2), "h": round(p.rect.height, 2)} for p in doc]
        fields: list[dict[str, Any]] = []
        for page_index, page in enumerate(doc):
            for w in page.widgets() or []:
                kind = _TYPE_NAMES.get(w.field_type, "other")
                visual = fitz.Rect(w.rect) * page.rotation_matrix
                visual.normalize()
                entry: dict[str, Any] = {
                    "id": w.xref,
                    "page": page_index,
                    "name": w.field_name,
                    "label": getattr(w, "field_label", None) or w.field_name,
                    "type": kind,
                    "fillable": kind in _FILLABLE,
                    "rect": [round(visual.x0, 2), round(visual.y0, 2), round(visual.x1, 2), round(visual.y1, 2)],
                    "readonly": bool(w.field_flags & _FLAG_READONLY),
                }
                if kind == "text":
                    entry["value"] = w.field_value or ""
                    entry["multiline"] = bool(w.field_flags & _FLAG_MULTILINE)
                    entry["password"] = bool(w.field_flags & _FLAG_PASSWORD)
                    entry["max_len"] = w.text_maxlen or None
                elif kind == "checkbox":
                    entry["checked"] = _is_checked(w)
                elif kind == "radio":
                    entry["on_state"] = w.on_state()
                    entry["checked"] = _is_checked(w)
                elif kind in ("combobox", "listbox"):
                    entry["value"] = w.field_value if isinstance(w.field_value, str) else ""
                    entry["options"] = [str(o) for o in (w.choice_values or [])]
                fields.append(entry)
        return {"pages": pages, "fields": fields, "has_xfa": _has_xfa(doc), "is_form": bool(doc.is_form_pdf)}
    finally:
        doc.close()


def fill_form(
    path: Path,
    output_path: Path,
    values: dict[str, Any],
    radios: dict[str, str],
    flatten: bool = False,
    password: str | None = None,
    progress_cb: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """`values` maps a widget id (xref, as str) to its value: str for text/choice fields,
    bool for check boxes. `radios` maps a radio group's field name to the chosen on-state
    (or "" to clear). Fields not mentioned keep their current value."""
    doc = _open(path, password)
    try:
        total = doc.page_count
        for page_index, page in enumerate(doc):
            if cancel_check and cancel_check():
                raise InterruptedError("cancelled")
            if progress_cb:
                progress_cb(page_index, total, f"第 {page_index + 1} 頁")
            for w in page.widgets() or []:
                kind = _TYPE_NAMES.get(w.field_type)
                if kind not in _FILLABLE or w.field_flags & _FLAG_READONLY:
                    continue
                key = str(w.xref)
                if kind == "radio":
                    if w.field_name not in radios:
                        continue
                    _set_radio(doc, w, radios[w.field_name])
                    continue
                if key not in values:
                    continue
                v = values[key]
                if kind == "checkbox":
                    w.field_value = w.on_state() if bool(v) else "Off"
                elif kind == "text":
                    text = "" if v is None else str(v)
                    if w.text_maxlen and len(text) > w.text_maxlen:
                        raise FormError(f"欄位「{w.field_name}」最多 {w.text_maxlen} 個字")
                    w.field_value = text
                else:
                    text = "" if v is None else str(v)
                    if text and text not in [str(o) for o in (w.choice_values or [])]:
                        raise FormError(f"欄位「{w.field_name}」沒有「{text}」這個選項")
                    w.field_value = text
                w.update()

        if flatten:
            doc.bake(annots=False, widgets=True)
        if progress_cb:
            progress_cb(total, total, "寫入輸出檔案")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(output_path), garbage=3, deflate=True)
        return output_path
    finally:
        doc.close()
