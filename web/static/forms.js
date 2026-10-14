// ---------- fill in a PDF form ----------
// Independent of the page editor: one PDF in, one new PDF out. Fields are detected on the
// server; here each field becomes a live input laid over a picture of its page.

const FM_PAGE_W = 720; // displayed page width (CSS px)

const fm = {
  file: null, // upload result
  info: null, // {pages, fields, has_xfa, is_form}
  values: {}, // widget id -> edited value (text / choice / checkbox)
  radios: {}, // radio group name -> chosen on-state ("" = none)
};

const FM_TYPE_LABELS = { text: "文字", checkbox: "核取方塊", radio: "單選群組", combobox: "下拉選單", listbox: "清單" };

async function fmOpenFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("請選擇 PDF 檔案");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  try {
    fmShowOpened(await apiFetch(`${API}/upload`, { method: "POST", body: form }));
  } catch (err) {
    showError(`上傳失敗：${err.message}`);
  }
}

function fmShowOpened(item) {
  const info = document.getElementById("form-info");
  info.innerHTML = "";
  info.classList.remove("hidden");
  info.append(h("div", {}, `檔名：${item.name}`));
  document.getElementById("form-workspace").classList.add("hidden");

  if (item.status === "encrypted") {
    info.append(h("div", { class: "file-error-msg" }, item.error_message || "PDF 有密碼保護，請輸入密碼"));
    info.append(buildUnlockRow(item.id, (updated) => fmShowOpened(updated)));
    return;
  }
  if (item.status === "error") {
    info.append(h("div", { class: "file-error-msg" }, item.error_message || "檔案無法開啟"));
    return;
  }
  fmLoadFields(item).catch((err) => showError(`讀取表單失敗：${err.message}`));
}

async function fmLoadFields(item) {
  const data = await apiFetch(`${API}/files/${item.id}/form`);
  const info = document.getElementById("form-info");
  fm.file = item;
  fm.info = data;
  fm.values = {};
  fm.radios = {};

  const fillable = data.fields.filter((f) => f.fillable);
  if (!fillable.length) {
    info.append(
      h(
        "div",
        { class: "file-error-msg" },
        data.has_xfa
          ? "這份 PDF 使用 XFA 動態表單，目前只支援一般（AcroForm）表單欄位，無法填寫。"
          : "這份 PDF 沒有可填寫的表單欄位。"
      )
    );
    return;
  }
  if (data.has_xfa) {
    info.append(h("div", { class: "picker-info" }, "提示：這份 PDF 含 XFA 動態表單，只會處理其中的一般表單欄位。"));
  }
  document.getElementById("form-workspace").classList.remove("hidden");
  fmRender();
}

function fmFieldSummary() {
  const counts = {};
  const groups = new Set();
  for (const f of fm.info.fields) {
    if (!f.fillable) continue;
    if (f.type === "radio") {
      if (groups.has(f.name)) continue;
      groups.add(f.name);
    }
    counts[f.type] = (counts[f.type] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([t, n]) => `${FM_TYPE_LABELS[t] || t} ${n}`);
  return `共 ${fm.info.pages.length} 頁，可填寫欄位：${parts.join("・")}`;
}

function fmRender() {
  document.getElementById("form-status").textContent = fmFieldSummary();
  const host = document.getElementById("form-pages");
  host.innerHTML = "";
  fm.info.pages.forEach((page, pageIndex) => {
    const scale = FM_PAGE_W / page.w;
    const box = h(
      "div",
      { class: "form-page", style: `width:${FM_PAGE_W}px;height:${page.h * scale}px` },
      h("img", { class: "form-page-bg", loading: "lazy", alt: `第 ${pageIndex + 1} 頁`, src: `${API}/files/${fm.file.id}/pages/${pageIndex}/image?w=1100&fmt=png&form=true` })
    );
    for (const f of fm.info.fields) {
      if (f.page !== pageIndex) continue;
      const [x0, y0, x1, y1] = f.rect;
      const style =
        `left:${(x0 / page.w) * 100}%;top:${(y0 / page.h) * 100}%;` +
        `width:${((x1 - x0) / page.w) * 100}%;height:${((y1 - y0) / page.h) * 100}%;` +
        `font-size:${Math.min(16, Math.max(9, (y1 - y0) * scale * 0.62))}px`;
      box.append(fmBuildControl(f, style));
    }
    host.append(h("div", { class: "form-page-wrap" }, h("div", { class: "form-page-label" }, `第 ${pageIndex + 1} 頁`), box));
  });
}

function fmBuildControl(f, style) {
  const common = { class: `form-field type-${f.type}`, style, title: f.label || f.name };
  if (!f.fillable) {
    return h("div", { ...common, class: common.class + " unsupported", title: `${f.label}（不支援此類欄位）` });
  }
  const disabled = f.readonly;
  if (f.type === "text") {
    const el = f.multiline
      ? h("textarea", { ...common, disabled })
      : h("input", { ...common, type: f.password ? "password" : "text", disabled });
    el.value = f.value || "";
    if (f.max_len) el.maxLength = f.max_len;
    el.addEventListener("input", () => (fm.values[f.id] = el.value));
    return el;
  }
  if (f.type === "checkbox") {
    const el = h("input", { ...common, type: "checkbox", disabled });
    el.checked = !!f.checked;
    el.addEventListener("change", () => (fm.values[f.id] = el.checked));
    return el;
  }
  if (f.type === "radio") {
    const el = h("input", { ...common, type: "radio", name: `fm-radio-${f.name}`, disabled });
    el.checked = !!f.checked;
    el.addEventListener("change", () => {
      if (el.checked) fm.radios[f.name] = f.on_state;
    });
    return el;
  }
  // combobox / listbox
  const sel = h(
    "select",
    { ...common, disabled, size: f.type === "listbox" ? String(Math.max(2, Math.round((f.rect[3] - f.rect[1]) / 14))) : null },
    f.type === "combobox" ? h("option", { value: "" }, "") : null,
    f.options.map((o) => h("option", { value: o }, o))
  );
  sel.value = f.value || "";
  sel.addEventListener("change", () => (fm.values[f.id] = sel.value));
  return sel;
}

function fmResetEdits() {
  fm.values = {};
  fm.radios = {};
  fmRender();
}

function fmOpenExportDialog() {
  const base = fm.file.name.replace(/\.pdf$/i, "");
  const nameInput = h("input", { type: "text", value: `${base}_filled.pdf` });
  const edited = Object.keys(fm.values).length + Object.keys(fm.radios).length;
  const mode = h(
    "select",
    {},
    h("option", { value: "keep" }, "保留可編輯（之後還能再修改欄位）"),
    h("option", { value: "flatten" }, "攤平（填寫內容變成固定文字，不可再編輯）")
  );
  openModal({
    title: "匯出填寫後的 PDF",
    body: h(
      "div",
      {},
      h("div", { class: "summary" }, h("div", {}, `已修改 ${edited} 個欄位${edited ? "" : "（尚未填寫任何內容）"}；原檔不會被覆寫`)),
      h("label", { class: "field" }, "輸出方式", mode),
      h("label", { class: "field" }, "輸出檔名", nameInput)
    ),
    actions: [
      { label: "取消" },
      { label: "確認匯出", primary: true, onClick: () => { fmExport(nameInput.value.trim() || `${base}_filled.pdf`, mode.value === "flatten"); } },
    ],
  });
}

async function fmExport(outputName, flatten) {
  const btn = document.getElementById("form-export-btn");
  let saveTarget = null;
  if (document.getElementById("form-save-as").checked && saveAsSupported()) {
    try {
      const name = outputName.toLowerCase().endsWith(".pdf") ? outputName : `${outputName}.pdf`;
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
      saveTarget = { type: "file", handle };
    } catch (err) {
      if (err.name === "AbortError") return;
      showError(`無法選擇儲存位置：${err.message}`);
      return;
    }
  }
  btn.disabled = true;
  hideResult("form-result");
  try {
    const { job_id } = await apiFetch(`${API}/forms/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fm.file.id, values: fm.values, radios: fm.radios, flatten, output_name: outputName }),
    });
    await watchJob(job_id, "form", saveTarget);
  } catch (err) {
    showError(`匯出失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (saveAsSupported()) document.getElementById("form-save-as-row").classList.remove("hidden");
  setupDropzone(
    document.getElementById("form-dropzone"),
    document.getElementById("form-file-input"),
    document.getElementById("form-add-btn"),
    (files) => fmOpenFile(files[0])
  );
  document.getElementById("form-export-btn").addEventListener("click", fmOpenExportDialog);
  document.getElementById("form-reset-btn").addEventListener("click", fmResetEdits);
  document.getElementById("form-highlight").addEventListener("change", (e) => {
    document.getElementById("form-pages").classList.toggle("no-highlight", !e.target.checked);
  });
});
