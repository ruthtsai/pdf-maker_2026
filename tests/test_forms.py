import io
import sys
from pathlib import Path

import pymupdf as fitz
import pytest

from core.file_utils import PdfEncryptedError
from core.forms import FormError, detect_fields, fill_form


def u16(s: str) -> str:
    return "<FEFF" + s.encode("utf-16-be").hex().upper() + ">"


def build_form_pdf(rotation: int = 0, readonly_name: bool = False) -> bytes:
    """A hand-written AcroForm: text, multiline text, check box, radio group, combo box, list box."""
    H = 500

    def rect(x0, y0, x1, y1):
        return f"[{x0} {H - y1} {x1} {H - y0}]"

    xobj = "<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 0 >>\nstream\n\nendstream"
    name_flags = "/Ff 1 " if readonly_name else ""
    objs = {
        1: "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R 8 0 R 9 0 R 10 0 R 13 0 R 14 0 R] "
           "/DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 20 0 R >> >> >> >>",
        2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Rotate {rotation} "
           "/Resources << /Font << /Helv 20 0 R >> >> /Annots [7 0 R 8 0 R 9 0 R 11 0 R 12 0 R 13 0 R 14 0 R] >>",
        20: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        7: f"<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) {name_flags}/Rect {rect(40, 40, 300, 62)} "
           "/DA (/Helv 12 Tf 0 g) /MaxLen 12 /P 3 0 R /F 4 >>",
        8: f"<< /Type /Annot /Subtype /Widget /FT /Tx /T (notes) /Ff 4096 /Rect {rect(40, 80, 300, 160)} "
           "/DA (/Helv 11 Tf 0 g) /P 3 0 R /F 4 >>",
        9: f"<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Off /AS /Off /Rect {rect(40, 180, 56, 196)} "
           "/AP << /N << /Yes 21 0 R /Off 22 0 R >> >> /MK << /CA (4) >> /DA (/Helv 0 Tf 0 g) /P 3 0 R /F 4 >>",
        10: "<< /FT /Btn /Ff 49152 /T (color) /V /Off /Kids [11 0 R 12 0 R] >>",
        11: f"<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect {rect(40, 220, 56, 236)} /AS /Off "
            "/AP << /N << /Red 23 0 R /Off 24 0 R >> >> /MK << /CA (l) >> /P 3 0 R /F 4 >>",
        12: f"<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect {rect(100, 220, 116, 236)} /AS /Off "
            "/AP << /N << /Blue 25 0 R /Off 26 0 R >> >> /MK << /CA (l) >> /P 3 0 R /F 4 >>",
        13: f"<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (city) /Opt [{u16('台北')} (Taichung) {u16('高雄')}] "
            f"/Rect {rect(40, 260, 240, 282)} /DA (/Helv 12 Tf 0 g) /P 3 0 R /F 4 >>",
        14: f"<< /Type /Annot /Subtype /Widget /FT /Ch /T (langs) /Opt [{u16('中文')} (English) {u16('日本語')}] "
            f"/Rect {rect(40, 300, 240, 360)} /DA (/Helv 12 Tf 0 g) /P 3 0 R /F 4 >>",
    }
    for n in (21, 22, 23, 24, 25, 26):
        objs[n] = xobj
    raw = io.BytesIO(b"%PDF-1.7\n")
    raw.seek(0, 2)
    for n, body in objs.items():
        raw.write(f"{n} 0 obj\n".encode() + body.encode("latin-1") + b"\nendobj\n")
    raw.write(b"trailer\n<< /Root 1 0 R /Size 30 >>\n%%EOF\n")
    doc = fitz.open(stream=raw.getvalue(), filetype="pdf")   # MuPDF rebuilds the xref table
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


@pytest.fixture
def form(tmp_path):
    p = tmp_path / "form.pdf"
    p.write_bytes(build_form_pdf())
    return p


def by_name(fields, name):
    return [f for f in fields if f["name"] == name]


def test_detects_every_field_type(form):
    info = detect_fields(form)
    assert info["is_form"] and not info["has_xfa"]
    types = {f["name"]: f["type"] for f in info["fields"]}
    assert types == {
        "name": "text", "notes": "text", "agree": "checkbox", "color": "radio", "city": "combobox", "langs": "listbox",
    }
    assert by_name(info["fields"], "notes")[0]["multiline"] is True
    assert by_name(info["fields"], "name")[0]["max_len"] == 12
    assert by_name(info["fields"], "city")[0]["options"] == ["台北", "Taichung", "高雄"]
    radios = by_name(info["fields"], "color")
    assert sorted(f["on_state"] for f in radios) == ["Blue", "Red"]


def test_non_form_pdf_has_no_fields(tmp_path):
    doc = fitz.open()
    doc.new_page()
    p = tmp_path / "plain.pdf"
    doc.save(str(p))
    info = detect_fields(p)
    assert info["fields"] == [] and info["is_form"] is False


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_field_rects_are_in_the_visual_frame(tmp_path, rotation):
    p = tmp_path / "r.pdf"
    p.write_bytes(build_form_pdf(rotation))
    info = detect_fields(p)
    page = info["pages"][0]
    name = by_name(info["fields"], "name")[0]["rect"]
    # un-rotated: x 40..300, y 40..62 on a 400x500 page. Map the corners ourselves.
    w, h = 400, 500
    corners = [(40, 40), (300, 62)]
    def to_visual(x, y):
        return {0: (x, y), 90: (h - y, x), 180: (w - x, h - y), 270: (y, w - x)}[rotation]
    (ax, ay), (bx, by) = (to_visual(*c) for c in corners)
    expected = [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]
    assert name == pytest.approx(expected, abs=0.6)
    assert (page["w"], page["h"]) == ((h, w) if rotation in (90, 270) else (w, h))


def test_fill_keeps_form_editable(form, tmp_path):
    info = detect_fields(form)
    ids = {f["name"]: f["id"] for f in info["fields"] if f["name"] != "color"}
    out = fill_form(
        form,
        tmp_path / "out.pdf",
        values={
            str(ids["name"]): "王小明 Ming",
            str(ids["notes"]): "第一行\nsecond",
            str(ids["agree"]): True,
            str(ids["city"]): "高雄",
            str(ids["langs"]): "日本語",
        },
        radios={"color": "Blue"},
    )
    after = {f["name"] + (f"/{f['on_state']}" if f["type"] == "radio" else ""): f for f in detect_fields(out)["fields"]}
    assert after["name"]["value"] == "王小明 Ming"
    assert after["notes"]["value"] == "第一行\nsecond"
    assert after["agree"]["checked"] is True
    assert after["city"]["value"] == "高雄"
    assert after["langs"]["value"] == "日本語"
    assert after["color/Blue"]["checked"] is True and after["color/Red"]["checked"] is False
    with fitz.open(out) as d:
        assert len(list(d[0].widgets())) == 6 + 1              # still real, editable fields (radio = 2 widgets)


def test_flatten_removes_fields_but_keeps_the_text(form, tmp_path):
    info = detect_fields(form)
    name_id = by_name(info["fields"], "name")[0]["id"]
    out = fill_form(form, tmp_path / "flat.pdf", {str(name_id): "王小明"}, {"color": "Red"}, flatten=True)
    with fitz.open(out) as d:
        assert list(d[0].widgets()) == []
        assert "王小明" in d[0].get_text()
    assert detect_fields(out)["fields"] == []


def test_original_file_is_untouched(form, tmp_path):
    before = form.read_bytes()
    info = detect_fields(form)
    fill_form(form, tmp_path / "o.pdf", {str(by_name(info["fields"], "name")[0]["id"]): "x"}, {})
    assert form.read_bytes() == before


def test_readonly_fields_are_not_modified(tmp_path):
    p = tmp_path / "ro.pdf"
    p.write_bytes(build_form_pdf(readonly_name=True))
    info = detect_fields(p)
    name = by_name(info["fields"], "name")[0]
    assert name["readonly"] is True
    out = fill_form(p, tmp_path / "o.pdf", {str(name["id"]): "changed"}, {})
    assert by_name(detect_fields(out)["fields"], "name")[0]["value"] == ""


def test_validation_errors(form, tmp_path):
    info = detect_fields(form)
    name_id = str(by_name(info["fields"], "name")[0]["id"])
    city_id = str(by_name(info["fields"], "city")[0]["id"])
    with pytest.raises(FormError, match="最多 12"):
        fill_form(form, tmp_path / "a.pdf", {name_id: "x" * 20}, {})
    with pytest.raises(FormError, match="沒有「紐約」"):
        fill_form(form, tmp_path / "b.pdf", {city_id: "紐約"}, {})


def test_radio_can_be_cleared(form, tmp_path):
    mid = fill_form(form, tmp_path / "m.pdf", {}, {"color": "Red"})
    assert any(f["checked"] for f in by_name(detect_fields(mid)["fields"], "color"))
    out = fill_form(mid, tmp_path / "o.pdf", {}, {"color": ""})
    assert not any(f["checked"] for f in by_name(detect_fields(out)["fields"], "color"))


def test_encrypted_form_needs_password(form, tmp_path):
    enc = tmp_path / "enc.pdf"
    with fitz.open(form) as d:
        d.save(str(enc), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    with pytest.raises(PdfEncryptedError):
        detect_fields(enc)
    assert detect_fields(enc, "pw")["is_form"]
    out = fill_form(enc, tmp_path / "o.pdf", {}, {"color": "Blue"}, password="pw")
    assert out.exists()


def test_flattened_radio_choice_is_actually_drawn(form, tmp_path):
    """Only the chosen radio button may leave ink on the flattened page."""
    info = detect_fields(form)
    rects = {f["on_state"]: f["rect"] for f in info["fields"] if f["type"] == "radio"}
    out = fill_form(form, tmp_path / "flat.pdf", {}, {"color": "Blue"}, flatten=True)
    with fitz.open(out) as d:
        pix = d[0].get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csGRAY, alpha=False)

    def ink(rect):
        x0, y0, x1, y1 = (int(v) for v in rect)
        return sum(1 for y in range(y0, y1) for x in range(x0, x1) if pix.samples[y * pix.width + x] < 128)

    assert ink(rects["Blue"]) > 10
    assert ink(rects["Red"]) == 0


def test_switching_radio_choice_between_exports(form, tmp_path):
    first = fill_form(form, tmp_path / "a.pdf", {}, {"color": "Red"})
    second = fill_form(first, tmp_path / "b.pdf", {}, {"color": "Blue"})
    states = {f["on_state"]: f["checked"] for f in detect_fields(second)["fields"] if f["type"] == "radio"}
    assert states == {"Red": False, "Blue": True}
