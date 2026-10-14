// ---------- page editor ----------
// The document being edited is just an ordered list of page references
// ({src file, page index, extra rotation}). Every operation edits that list;
// a new PDF is only built on the server when the user exports.

const ED_BOX = 150; // thumbnail box (CSS px)
const ED_THUMB_W = 280; // thumbnail image width requested from the server

const ed = {
  sources: {}, // fileId -> {id, name, page_count, status, pages:[{w,h,rotation}]}
  baseId: null,
  pages: [], // [{uid, src, idx, rot}]
  selection: new Set(), // uids
  anchor: null, // uid used as the start of a Shift range
  nextUid: 1,
};

// ---------- tiny DOM helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function openModal({ title, body, actions = [], onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const foot = h("div", { class: "modal-foot" });
  for (const a of actions) {
    foot.append(
      h(
        "button",
        {
          class: "btn" + (a.primary ? " btn-primary" : ""),
          onclick: async () => {
            const keepOpen = a.onClick ? await a.onClick(close) : false;
            if (!keepOpen) close();
          },
        },
        a.label
      )
    );
  }
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() },
    h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-head" }, h("span", {}, title), h("button", { class: "btn-icon", onclick: close }, "✕")),
      h("div", { class: "modal-body" }, body),
      actions.length ? foot : null
    )
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { close, backdrop };
}

// ---------- geometry ----------

function edPageSize(page) {
  const src = ed.sources[page.src];
  const sp = src && src.pages && src.pages[page.idx];
  return sp ? { w: sp.w, h: sp.h } : { w: 210, h: 297 };
}

// Size to give the (un-rotated) <img> so that, after CSS-rotating it by `rot`,
// the visual result fits inside boxW x boxH.
function edFit(page, boxW, boxH) {
  const { w, h: ph } = edPageSize(page);
  const swapped = page.rot % 180 !== 0;
  const vw = swapped ? ph : w;
  const vh = swapped ? w : ph;
  const scale = Math.min(boxW / vw, boxH / vh);
  return { w: w * scale, h: ph * scale };
}

function edImageUrl(page, width) {
  return `${API}/files/${page.src}/pages/${page.idx}/image?w=${width}`;
}

function edPositionOf(uid) {
  return ed.pages.findIndex((p) => p.uid === uid);
}

// ---------- session ----------

function edNewPage(src, idx, rot = 0) {
  return { uid: ed.nextUid++, src, idx, rot };
}

async function edLoadInfo(fileId) {
  const info = await apiFetch(`${API}/files/${fileId}/info`);
  ed.sources[fileId].pages = info.pages;
  return info;
}

async function edOpenFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("請選擇 PDF 檔案");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  let item;
  try {
    item = await apiFetch(`${API}/upload`, { method: "POST", body: form });
  } catch (err) {
    showError(`上傳失敗：${err.message}`);
    return;
  }
  edShowOpened(item);
}

function edShowOpened(item) {
  const info = document.getElementById("edit-info");
  info.innerHTML = "";
  info.classList.remove("hidden");
  info.append(h("div", {}, `檔名：${item.name}`));

  if (item.status === "encrypted") {
    document.getElementById("edit-workspace").classList.add("hidden");
    info.append(h("div", { class: "file-error-msg" }, item.error_message || "PDF 有密碼保護，請輸入密碼"));
    info.append(buildUnlockRow(item.id, (updated) => edShowOpened(updated)));
    return;
  }
  if (item.status === "error") {
    document.getElementById("edit-workspace").classList.add("hidden");
    info.append(h("div", { class: "file-error-msg" }, item.error_message || "檔案無法開啟"));
    return;
  }
  edStartSession(item).catch((err) => showError(`開啟失敗：${err.message}`));
}

async function edStartSession(item) {
  ed.sources = { [item.id]: { id: item.id, name: item.name, page_count: item.page_count, status: item.status, pages: null } };
  ed.baseId = item.id;
  await edLoadInfo(item.id);
  ed.nextUid = 1;
  ed.pages = Array.from({ length: item.page_count }, (_, i) => edNewPage(item.id, i));
  ed.selection = new Set();
  ed.anchor = null;
  hideResult("edit-result");
  document.getElementById("edit-workspace").classList.remove("hidden");
  edRender();
}

// ---------- rendering ----------

function edUpdateStatus() {
  const n = ed.pages.length;
  const k = ed.selection.size;
  document.getElementById("edit-status").textContent = `共 ${n} 頁` + (k ? `・已選取 ${k} 頁` : "");
}

function edBuildCell(page, position) {
  const fit = edFit(page, ED_BOX, ED_BOX);
  const img = h("img", {
    loading: "lazy",
    alt: `第 ${position + 1} 頁`,
    src: edImageUrl(page, ED_THUMB_W),
    style: `width:${fit.w}px;height:${fit.h}px;transform:rotate(${page.rot}deg)`,
  });
  const origin = ed.sources[page.src];
  const sub = page.src === ed.baseId ? "" : `${origin ? origin.name : "?"} 第 ${page.idx + 1} 頁`;
  const cell = h(
    "div",
    {
      class: "page-cell" + (ed.selection.has(page.uid) ? " selected" : ""),
      draggable: "true",
      dataset: { uid: page.uid },
    },
    h("button", { class: "page-zoom", title: "放大預覽", onclick: (e) => { e.stopPropagation(); edOpenPreview(page.uid); } }, "🔍"),
    h("div", { class: "thumb-box" }, img),
    h("div", { class: "page-label" }, `第 ${position + 1} 頁` + (page.rot ? `（↻${page.rot}°）` : "")),
    h("div", { class: "page-sub", title: sub }, sub)
  );
  cell.addEventListener("click", (e) => edHandleClick(e, page.uid));
  cell.addEventListener("dblclick", () => edOpenPreview(page.uid));
  return cell;
}

function edRender() {
  const grid = document.getElementById("edit-grid");
  grid.innerHTML = "";
  ed.pages.forEach((page, i) => grid.append(edBuildCell(page, i)));
  edUpdateStatus();
  document.dispatchEvent(new CustomEvent("editor:rendered"));
}

// ---------- selection ----------

function edHandleClick(e, uid) {
  const toggle = e.ctrlKey || e.metaKey;
  if (e.shiftKey && ed.anchor !== null && edPositionOf(ed.anchor) >= 0) {
    const a = edPositionOf(ed.anchor);
    const b = edPositionOf(uid);
    const [from, to] = a < b ? [a, b] : [b, a];
    const range = ed.pages.slice(from, to + 1).map((p) => p.uid);
    ed.selection = toggle ? new Set([...ed.selection, ...range]) : new Set(range);
  } else if (toggle) {
    if (ed.selection.has(uid)) ed.selection.delete(uid);
    else ed.selection.add(uid);
    ed.anchor = uid;
  } else {
    ed.selection = new Set([uid]);
    ed.anchor = uid;
  }
  edRefreshSelection();
}

function edRefreshSelection() {
  document.querySelectorAll("#edit-grid .page-cell").forEach((cell) => {
    cell.classList.toggle("selected", ed.selection.has(Number(cell.dataset.uid)));
  });
  edUpdateStatus();
  document.dispatchEvent(new CustomEvent("editor:selection"));
}

function edSelectAll() {
  ed.selection = new Set(ed.pages.map((p) => p.uid));
  edRefreshSelection();
}

function edSelectNone() {
  ed.selection = new Set();
  edRefreshSelection();
}

// ---------- rotate ----------

// Applies to the selection, or to the whole document when nothing is selected.
function edRotate(degrees) {
  const targets = ed.selection.size ? ed.pages.filter((p) => ed.selection.has(p.uid)) : ed.pages;
  targets.forEach((p) => {
    p.rot = (p.rot + degrees) % 360;
  });
  edRender();
}

// ---------- single page preview ----------

function edOpenPreview(startUid) {
  let pos = edPositionOf(startUid);
  if (pos < 0) return;
  const stageImg = h("img", { alt: "" });
  const label = h("span", {});
  const prev = h("button", { class: "preview-nav", title: "上一頁", onclick: () => go(-1) }, "◀");
  const next = h("button", { class: "preview-nav", title: "下一頁", onclick: () => go(1) }, "▶");
  const stage = h("div", { class: "preview-stage" }, prev, stageImg, next);

  const boxW = Math.min(760, window.innerWidth - 220);
  const boxH = Math.min(620, window.innerHeight - 220);

  function show() {
    const page = ed.pages[pos];
    const fit = edFit(page, boxW, boxH);
    stageImg.src = edImageUrl(page, 1100);
    stageImg.style.width = `${fit.w}px`;
    stageImg.style.height = `${fit.h}px`;
    stageImg.style.transform = `rotate(${page.rot}deg)`;
    stage.style.minHeight = `${boxH + 24}px`;
    label.textContent = `第 ${pos + 1} 頁 / 共 ${ed.pages.length} 頁`;
    prev.disabled = pos === 0;
    next.disabled = pos === ed.pages.length - 1;
  }
  function go(d) {
    const np = pos + d;
    if (np < 0 || np >= ed.pages.length) return;
    pos = np;
    show();
  }
  const onKey = (e) => {
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  };
  document.addEventListener("keydown", onKey);
  show();
  openModal({
    title: label,
    body: stage,
    actions: [{ label: "關閉" }],
    onClose: () => document.removeEventListener("keydown", onKey),
  });
}

// ---------- export ----------

function edSummary() {
  const base = ed.sources[ed.baseId];
  const foreign = ed.pages.filter((p) => p.src !== ed.baseId).length;
  const rotated = ed.pages.filter((p) => p.rot).length;
  const parts = [`原始檔案 ${base.page_count} 頁 → 輸出 ${ed.pages.length} 頁`];
  if (foreign) parts.push(`其中 ${foreign} 頁來自其他 PDF`);
  if (rotated) parts.push(`${rotated} 頁已旋轉`);
  return parts;
}

function edRecipe(outputName) {
  return {
    pages: ed.pages.map((p) => ({ src: p.src, idx: p.idx, rot: p.rot })),
    output_name: outputName,
  };
}

function edOpenExportDialog() {
  const base = ed.sources[ed.baseId];
  const defaultName = base.name.replace(/\.pdf$/i, "") + "_edited.pdf";
  const nameInput = h("input", { type: "text", value: defaultName });
  openModal({
    title: "匯出新檔",
    body: h(
      "div",
      {},
      h("div", { class: "summary" }, edSummary().map((t) => h("div", {}, t))),
      h("label", { class: "field" }, "輸出檔名（不會覆寫原檔）", nameInput)
    ),
    actions: [
      { label: "取消" },
      { label: "確認匯出", primary: true, onClick: () => { edExport(nameInput.value.trim() || defaultName); } },
    ],
  });
}

async function edExport(outputName) {
  const btn = document.getElementById("edit-export-btn");
  let saveTarget = null;
  if (document.getElementById("edit-save-as").checked && saveAsSupported()) {
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
  hideResult("edit-result");
  try {
    const { job_id } = await apiFetch(`${API}/edit/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edRecipe(outputName)),
    });
    await watchJob(job_id, "edit", saveTarget);
  } catch (err) {
    showError(`匯出失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  if (saveAsSupported()) document.getElementById("edit-save-as-row").classList.remove("hidden");

  setupDropzone(
    document.getElementById("edit-dropzone"),
    document.getElementById("edit-file-input"),
    document.getElementById("edit-add-btn"),
    (files) => edOpenFile(files[0])
  );
  document.getElementById("edit-select-all").addEventListener("click", edSelectAll);
  document.getElementById("edit-select-none").addEventListener("click", edSelectNone);
  document.getElementById("edit-export-btn").addEventListener("click", edOpenExportDialog);
  document.querySelectorAll("#edit-toolbar [data-rotate]").forEach((btn) => {
    btn.addEventListener("click", () => edRotate(Number(btn.dataset.rotate)));
  });
});
