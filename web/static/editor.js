import {
  DEFAULT_NUMBERING,
  createEditSession,
  moveBookmarkSubtree,
  removeBookmark,
  shiftBookmarkLevel,
  stampScopeKind,
} from "./edit-session.js";
import { h, openModal } from "./ui.js";

// ---------- page editor ----------
// The view of the Edit Session: everything on screen, and every server request.

const ED_BOX = 150; // thumbnail box (CSS px)
const ED_THUMB_W = 280; // thumbnail image width requested from the server
const ED_HEARTBEAT_MS = 5 * 60 * 1000; // the server sweeps files idle for 30 minutes

let ed = null; // the current Edit Session; replaced whenever another file is opened
let edDragUids = null; // uids being dragged while a reorder drag is active

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

// "5-7,9" -> [5,6,7,9] (1-based, sorted, unique). Throws Error with a user-facing message.
function edParseRange(text, total, what = "頁碼") {
  const t = (text || "").trim();
  if (!t) throw new Error(`請輸入${what}`);
  if (!PAGE_RANGE_RE.test(t)) throw new Error(`${what}格式錯誤，範例：1-5,8,10-12`);
  const out = new Set();
  for (const part of t.split(",")) {
    const [a, b] = part.trim().split("-").map(Number);
    const to = b === undefined ? a : b;
    if (a < 1 || to < a) throw new Error(`${what}範圍無效：${part.trim()}`);
    if (to > total) throw new Error(`${what} ${to} 超出範圍（共 ${total} 頁）`);
    for (let n = a; n <= to; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

// [1,2,3,5] -> "1-3,5"
function edCompactRange(nums) {
  const out = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return out.join(",");
}

function edUpdateHistoryButtons() {
  document.getElementById("edit-undo").disabled = !ed.canUndo;
  document.getElementById("edit-redo").disabled = !ed.canRedo;
}

async function edOpenFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("請選擇 PDF 檔案");
    return;
  }
  if (ed && ed.edited && !confirm("目前的編輯內容尚未匯出，確定要改開另一個檔案嗎？")) return;
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
  const info = await apiFetch(`${API}/files/${item.id}/info`);
  const previous = ed ? Object.keys(ed.sources) : [];
  ed = createEditSession(item, info);
  ed.subscribe(edRender);
  hideResult("edit-result");
  document.getElementById("edit-workspace").classList.remove("hidden");
  edRender();
  previous.filter((id) => id !== item.id).forEach((id) => apiFetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {}));
}

// ---------- keeping files alive ----------
// Reordering, rotating and bookmarks never reach the server, so the files the session
// uses are reported regularly; otherwise the server would sweep them as idle.

function edFileName(id) {
  if (ed.sources[id]) return ed.sources[id].name;
  const st = ed.stamps.find((s) => s.file === id);
  return st ? st.name : id;
}

async function edHeartbeat() {
  if (!ed) return;
  const session = ed;
  let missing;
  try {
    ({ missing } = await apiFetch(`${API}/files/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: session.referencedFiles() }),
    }));
  } catch {
    return; // the server may be restarting; try again next time
  }
  if (session !== ed || !missing.length) return;
  const names = missing.map(edFileName).join("、");
  showError(`伺服器上已找不到這些檔案，編輯內容無法再匯出：${names}。請重新開啟檔案。`);
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
  edBindDrag(cell, page);
  return cell;
}

function edRender() {
  const grid = document.getElementById("edit-grid");
  grid.innerHTML = "";
  ed.pages.forEach((page, i) => grid.append(edBuildCell(page, i)));
  edUpdateStatus();
  edUpdateHistoryButtons();
}

// ---------- selection ----------

function edHandleClick(e, uid) {
  ed.clickPage(uid, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  edRefreshSelection();
}

function edRefreshSelection() {
  document.querySelectorAll("#edit-grid .page-cell").forEach((cell) => {
    cell.classList.toggle("selected", ed.selection.has(Number(cell.dataset.uid)));
  });
  edUpdateStatus();
}

function edSelectUids(uids) {
  ed.select(uids);
  edRefreshSelection();
}

const edSelectAll = () => {
  if (!ed) return;
  ed.selectAll();
  edRefreshSelection();
};
const edSelectNone = () => edSelectUids([]);

// ---------- drag to reorder ----------

function edClearDropMarks() {
  document.querySelectorAll("#edit-grid .drop-before, #edit-grid .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
  document.getElementById("edit-grid").classList.remove("drop-end");
}

function edBindDrag(cell, page) {
  cell.addEventListener("dragstart", (e) => {
    if (!ed.selection.has(page.uid)) edSelectUids([page.uid]);
    edDragUids = ed.pages.filter((p) => ed.selection.has(p.uid)).map((p) => p.uid);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(page.uid));
    document.querySelectorAll("#edit-grid .page-cell.selected").forEach((c) => c.classList.add("dragging"));
  });
  cell.addEventListener("dragend", () => {
    edDragUids = null;
    document.querySelectorAll("#edit-grid .dragging").forEach((c) => c.classList.remove("dragging"));
    edClearDropMarks();
  });
  cell.addEventListener("dragover", (e) => {
    if (!edDragUids) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cell.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    edClearDropMarks();
    cell.classList.add(after ? "drop-after" : "drop-before");
  });
  cell.addEventListener("drop", (e) => {
    if (!edDragUids) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cell.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const uids = edDragUids;
    edDragUids = null;
    edClearDropMarks();
    ed.moveBlock(uids, page.uid, after);
  });
}

function edBindGridDrop() {
  const grid = document.getElementById("edit-grid");
  grid.addEventListener("dragover", (e) => {
    if (!edDragUids) return;
    e.preventDefault();
    edClearDropMarks();
    grid.classList.add("drop-end");
  });
  grid.addEventListener("dragleave", (e) => {
    if (e.target === grid) grid.classList.remove("drop-end");
  });
  grid.addEventListener("drop", (e) => {
    if (!edDragUids) return;
    e.preventDefault();
    const uids = edDragUids;
    edDragUids = null;
    edClearDropMarks();
    ed.moveBlock(uids, null, false);
  });
}

// ---------- move by page number ----------

function edOpenMoveDialog() {
  const total = ed.pages.length;
  const pos = ed.selectedPositions();
  const fromInput = h("input", { type: "text", value: pos.length ? edCompactRange(pos) : "", placeholder: "例如 5 或 5-7,9" });
  const toInput = h("input", { type: "number", min: "0", max: String(total), value: "0" });
  const err = h("div", { class: "dialog-error" });
  openModal({
    title: "移動頁面",
    body: h(
      "div",
      {},
      h("label", { class: "field" }, "要移動的頁面（頁碼或範圍）", fromInput),
      h("label", { class: "field" }, `移到第幾頁之後（0＝移到最前面，最大 ${total}）`, toInput),
      h("div", { class: "picker-info" }, "例：要把第 5 頁移到第 2 頁後面，就填「5」與「2」。頁碼以目前畫面上的順序為準。"),
      err
    ),
    actions: [
      { label: "取消" },
      {
        label: "移動",
        primary: true,
        onClick: () => {
          try {
            ed.movePages(edParseRange(fromInput.value, total), Number(toInput.value));
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
  });
}

// ---------- delete pages ----------

function edOpenDeleteDialog() {
  const total = ed.pages.length;
  const pos = ed.selectedPositions();
  const input = h("input", { type: "text", value: pos.length ? edCompactRange(pos) : "", placeholder: "例如 5 或 5-7,9" });
  const err = h("div", { class: "dialog-error" });
  openModal({
    title: "刪除頁面",
    body: h(
      "div",
      {},
      h("label", { class: "field" }, `要刪除的頁面（頁碼或範圍，共 ${total} 頁）`, input),
      h("div", { class: "picker-info" }, "頁碼以目前畫面上的順序為準。刪除後可按「還原」復原。"),
      err
    ),
    actions: [
      { label: "取消" },
      {
        label: "刪除",
        primary: true,
        onClick: () => {
          try {
            ed.deletePages(edParseRange(input.value, total));
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
  });
}

// Delete key: no confirmation, since undo brings the pages back.
function edDeleteSelection() {
  const pos = ed.selectedPositions();
  if (!pos.length) return;
  try {
    ed.deletePages(pos);
  } catch (e) {
    showError(e.message);
  }
}

// ---------- pick another PDF (shared by insert and, later, replace) ----------

function edSourcePicker(onChange) {
  let picked = null;
  const uploaded = [];
  const info = h("div", { class: "picker-info" }, "尚未選擇檔案");
  const holder = h("div", {});
  const input = h("input", { type: "file", accept: ".pdf,application/pdf" });

  async function handle(item) {
    holder.innerHTML = "";
    if (item.status === "encrypted") {
      info.textContent = "此 PDF 有密碼保護，請輸入密碼";
      holder.append(buildUnlockRow(item.id, handle));
      return;
    }
    if (item.status === "error") {
      info.textContent = item.error_message || "檔案無法開啟";
      return;
    }
    const details = await apiFetch(`${API}/files/${item.id}/info`);
    picked = ed.addSource(item, details.pages);
    info.textContent = `${item.name}（共 ${item.page_count} 頁）`;
    onChange(picked);
  }

  input.addEventListener("change", async () => {
    picked = null;
    onChange(null);
    holder.innerHTML = "";
    const file = input.files[0];
    if (!file) return;
    info.textContent = "上傳中…";
    const form = new FormData();
    form.append("file", file);
    try {
      const item = await apiFetch(`${API}/upload`, { method: "POST", body: form });
      uploaded.push(item.id);
      await handle(item);
    } catch (err) {
      info.textContent = `上傳失敗：${err.message}`;
    }
  });

  return {
    el: h("div", {}, h("label", { class: "field" }, "選擇 PDF", input), info, holder),
    get source() {
      return picked;
    },
    // Files uploaded for a dialog that never made it into the document are discarded.
    cleanup() {
      uploaded.forEach((id) => {
        if (ed.referencesFile(id)) return;
        ed.forgetSource(id);
        apiFetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {});
      });
    },
  };
}

// ---------- insert another PDF ----------

function edOpenInsertDialog() {
  const total = ed.pages.length;
  const rangeInput = h("input", { type: "text", placeholder: "留空＝整份；或例如 1-3,5", disabled: true });
  const afterInput = h("input", { type: "number", min: "0", max: String(total), value: String(total) });
  const err = h("div", { class: "dialog-error" });
  const picker = edSourcePicker((src) => {
    rangeInput.disabled = !src;
    err.textContent = "";
  });
  openModal({
    title: "插入另一份 PDF",
    body: h(
      "div",
      {},
      picker.el,
      h(
        "div",
        { class: "field-row" },
        h("label", { class: "field" }, "要插入的頁碼範圍", rangeInput),
        h("label", { class: "field" }, `插入在第幾頁之後（0＝最前面，最大 ${total}）`, afterInput)
      ),
      err
    ),
    actions: [
      { label: "取消" },
      {
        label: "插入",
        primary: true,
        onClick: () => {
          const src = picker.source;
          if (!src) {
            err.textContent = "請先選擇要插入的 PDF";
            return true;
          }
          try {
            const text = rangeInput.value.trim();
            const nums = text ? edParseRange(text, src.page_count) : Array.from({ length: src.page_count }, (_, i) => i + 1);
            ed.insertPages(src.id, nums, Number(afterInput.value));
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
    onClose: () => picker.cleanup(),
  });
}

// ---------- replace pages ----------

function edBuildCompareRow(targetPos, oldPage, newSource, newIdx) {
  const side = (page, tag, caption) => {
    const fit = edFit(page, 150, 190);
    return h(
      "div",
      { class: "compare-side" },
      h("span", { class: `tag ${tag}` }, tag === "old" ? "取代前" : "取代後"),
      h(
        "div",
        { class: "thumb-box" },
        h("img", { src: edImageUrl(page, 300), style: `width:${fit.w}px;height:${fit.h}px;transform:rotate(${page.rot}deg)` })
      ),
      h("div", { class: "compare-caption" }, caption)
    );
  };
  const newPage = { src: newSource.id, idx: newIdx, rot: 0 };
  const oldName = oldPage.src === ed.baseId ? "" : `${ed.sources[oldPage.src].name} `;
  return h(
    "div",
    { class: "compare-row" },
    side(oldPage, "old", `第 ${targetPos} 頁（${oldName}原第 ${oldPage.idx + 1} 頁）`),
    h("span", { class: "compare-arrow" }, "→"),
    side(newPage, "new", `${newSource.name} 第 ${newIdx + 1} 頁`)
  );
}

function edOpenReplaceDialog() {
  const total = ed.pages.length;
  const pos = ed.selectedPositions();
  const srcRange = h("input", { type: "text", placeholder: "例如 1-2", disabled: true });
  const targetRange = h("input", { type: "text", value: pos.length ? edCompactRange(pos) : "", placeholder: "例如 3-4" });
  const err = h("div", { class: "dialog-error" });
  let proceeding = false;
  const picker = edSourcePicker((src) => {
    srcRange.disabled = !src;
    err.textContent = "";
  });

  const dialog = openModal({
    title: "取代頁面",
    body: h(
      "div",
      {},
      picker.el,
      h(
        "div",
        { class: "field-row" },
        h("label", { class: "field" }, "來源 PDF 的頁碼", srcRange),
        h("label", { class: "field" }, `要被取代的頁碼（目前共 ${total} 頁）`, targetRange)
      ),
      h("div", { class: "picker-info" }, "來源頁依序取代目標頁（第 1 個來源頁取代第 1 個目標頁，以此類推），兩邊的頁數必須相同。"),
      err
    ),
    actions: [
      { label: "取消" },
      {
        label: "預覽對照",
        primary: true,
        onClick: () => {
          const src = picker.source;
          if (!src) {
            err.textContent = "請先選擇來源 PDF";
            return true;
          }
          let srcNums, targetNums;
          try {
            srcNums = edParseRange(srcRange.value, src.page_count, "來源頁碼");
            targetNums = edParseRange(targetRange.value, total, "目標頁碼");
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
          if (srcNums.length !== targetNums.length) {
            err.textContent = `來源有 ${srcNums.length} 頁、目標有 ${targetNums.length} 頁，數量需相同`;
            return true;
          }
          proceeding = true;
          const pairs = targetNums.map((p, i) => ({ pos: p, srcIdx: srcNums[i] - 1 }));
          edOpenReplaceCompare(src, pairs, picker);
        },
      },
    ],
    onClose: () => {
      if (!proceeding) picker.cleanup();
    },
  });
  return dialog;
}

function edOpenReplaceCompare(source, pairs, picker) {
  openModal({
    title: `取代前後對照（共 ${pairs.length} 頁）`,
    body: h(
      "div",
      { class: "compare-list" },
      pairs.map(({ pos, srcIdx }) => edBuildCompareRow(pos, ed.pages[pos - 1], source, srcIdx))
    ),
    actions: [
      { label: "取消" },
      { label: "確認取代", primary: true, onClick: () => { ed.replacePages(source.id, pairs); } },
    ],
    onClose: () => picker.cleanup(),
  });
}

// ---------- page numbers ----------

const ED_LABEL_STYLES = [
  ["D", "阿拉伯數字 1, 2, 3"],
  ["r", "小寫羅馬 i, ii, iii"],
  ["R", "大寫羅馬 I, II, III"],
  ["a", "小寫字母 a, b, c"],
  ["A", "大寫字母 A, B, C"],
  ["", "無編號（只有前綴）"],
];
const ED_NUMBER_FORMATS = [
  ["number", "1, 2, 3"],
  ["roman", "i, ii, iii"],
  ["roman_upper", "I, II, III"],
  ["of", "第 N 頁／共 M 頁"],
];

function edNumInput(value, min, max, onInput) {
  const el = h("input", { type: "number", min: String(min), max: String(max), value: String(value) });
  el.addEventListener("input", () => onInput(Number(el.value)));
  return el;
}

function edSelect(options, value, onChange) {
  const el = h(
    "select",
    {},
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label))
  );
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function edOpenNumberingDialog() {
  const total = ed.pages.length;
  let rules = ed.labels.map((r) => ({ ...r }));
  let stampOn = !!ed.numbering;
  const stamp = { ...(ed.numbering || DEFAULT_NUMBERING) };
  let previewIndex = Math.min(Math.max(stamp.start_page, 1), total) - 1;
  let timer = null;
  let objectUrl = null;
  let token = 0;
  const err = h("div", { class: "dialog-error" });

  // ----- live preview (rendered by the server exactly like the export) -----
  const previewImg = h("img", { alt: "" });
  const previewNote = h("div", { class: "picker-info" }, "");
  async function refreshPreview() {
    const mine = ++token;
    previewNote.textContent = stampOn ? `預覽第 ${previewIndex + 1} 頁` : "尚未啟用蓋印頁碼，預覽為原始頁面";
    try {
      const body = ed.recipe("preview.pdf", { page_labels: [], page_numbers: stampOn ? { ...stamp } : null });
      const res = await fetch(`${API}/edit/preview?index=${previewIndex}&w=520`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      const url = URL.createObjectURL(await res.blob());
      if (mine !== token) return URL.revokeObjectURL(url);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = url;
      previewImg.src = url;
    } catch (e) {
      previewNote.textContent = `預覽失敗：${e.message}`;
    }
  }
  const schedulePreview = () => {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 250);
  };

  // ----- label rules -----
  const rulesBox = h("div", {});
  function renderRules() {
    rulesBox.innerHTML = "";
    rules.forEach((r, i) => {
      rulesBox.append(
        h(
          "div",
          { class: "rule-row" },
          "從第",
          edNumInput(r.start + 1, 1, total, (v) => (r.start = v - 1)),
          "頁起",
          edSelect(ED_LABEL_STYLES, r.style, (v) => (r.style = v)),
          "前綴",
          h("input", { type: "text", value: r.prefix, oninput: (e) => (r.prefix = e.target.value) }),
          "起始號碼",
          edNumInput(r.first, 1, 99999, (v) => (r.first = v)),
          h(
            "button",
            {
              class: "btn-icon",
              title: "移除此規則",
              onclick: () => {
                rules.splice(i, 1);
                renderRules();
              },
            },
            "✕"
          )
        )
      );
    });
    if (!rules.length) rulesBox.append(h("div", { class: "picker-info" }, "目前沒有頁碼標籤規則（輸出檔不寫入頁碼標籤）"));
  }
  renderRules();

  const frontInput = h("input", { type: "number", min: "1", max: String(Math.max(total - 1, 1)), value: "3" });

  // ----- stamp controls -----
  const stampBox = h(
    "div",
    {},
    h(
      "div",
      { class: "inline-row" },
      "位置：",
      edSelect([["top", "頁首"], ["bottom", "頁尾"]], stamp.v_pos, (v) => { stamp.v_pos = v; schedulePreview(); }),
      edSelect([["left", "靠左"], ["center", "置中"], ["right", "靠右"]], stamp.h_pos, (v) => { stamp.h_pos = v; schedulePreview(); })
    ),
    h(
      "div",
      { class: "inline-row" },
      "格式：",
      edSelect(ED_NUMBER_FORMATS, stamp.fmt, (v) => { stamp.fmt = v; schedulePreview(); })
    ),
    h(
      "div",
      { class: "inline-row" },
      "從第",
      edNumInput(stamp.start_page, 1, total, (v) => { stamp.start_page = v; schedulePreview(); }),
      "頁開始蓋印，起始號碼",
      edNumInput(stamp.start_number, 0, 99999, (v) => { stamp.start_number = v; schedulePreview(); }),
      "字型大小",
      edNumInput(stamp.font_size, 4, 72, (v) => { stamp.font_size = v; schedulePreview(); })
    ),
    h(
      "div",
      { class: "inline-row" },
      "預覽第",
      edNumInput(previewIndex + 1, 1, total, (v) => {
        previewIndex = Math.min(Math.max(v || 1, 1), total) - 1;
        schedulePreview();
      }),
      "頁"
    )
  );
  const enable = h("input", { type: "checkbox", checked: stampOn });
  const syncEnabled = () => {
    stampBox.style.opacity = stampOn ? "1" : ".45";
    stampBox.style.pointerEvents = stampOn ? "auto" : "none";
  };
  enable.addEventListener("change", () => {
    stampOn = enable.checked;
    syncEnabled();
    schedulePreview();
  });
  syncEnabled();

  const body = h(
    "div",
    { class: "num-layout" },
    h(
      "div",
      { class: "num-controls" },
      h(
        "div",
        { class: "section-box" },
        h("div", { class: "section-title" }, "① 頁碼標籤（PDF 閱讀器頁碼框顯示的編號）"),
        h(
          "div",
          { class: "inline-row" },
          "快速設定：前言",
          frontInput,
          "頁用羅馬數字，正文從 1 起算",
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                const n = Number(frontInput.value);
                if (!Number.isInteger(n) || n < 1 || n >= total) {
                  err.textContent = `前言頁數需介於 1 到 ${total - 1}`;
                  return;
                }
                err.textContent = "";
                rules = [
                  { start: 0, style: "r", prefix: "", first: 1 },
                  { start: n, style: "D", prefix: "", first: 1 },
                ];
                renderRules();
              },
            },
            "套用"
          )
        ),
        rulesBox,
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              rules.push({ start: 0, style: "D", prefix: "", first: 1 });
              renderRules();
            },
          },
          "＋ 新增規則"
        ),
        h("div", { class: "picker-info" }, "頁數以輸出後的順序計算；每條規則從指定頁一直套用到下一條規則之前。")
      ),
      h(
        "div",
        { class: "section-box" },
        h("div", { class: "section-title" }, h("label", {}, enable, " ② 在頁面上蓋印頁碼")),
        stampBox
      ),
      err
    ),
    h("div", { class: "num-preview" }, h("div", { class: "num-preview-frame" }, previewImg), previewNote)
  );

  const dialog = openModal({
    title: "頁碼設定",
    body,
    actions: [
      { label: "取消" },
      {
        label: "套用",
        primary: true,
        onClick: () => {
          try {
            ed.applyPageNumbers(rules, stampOn ? stamp : null);
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
    onClose: () => {
      clearTimeout(timer);
      token++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  });
  dialog.backdrop.querySelector(".modal").classList.add("wide");
  refreshPreview();
}

// ---------- bookmarks ----------

function edOpenBookmarkDialog() {
  const total = ed.pages.length;
  let items = ed.bookmarks.map((b) => ({ ...b }));
  let nextId = Math.max(0, ...items.map((b) => b.id)) + 1;
  const err = h("div", { class: "dialog-error" });
  const list = h("div", { class: "bm-list" });
  let dragIndex = null;

  function update(next) {
    items = next;
    render();
  }

  function render() {
    list.innerHTML = "";
    if (!items.length) list.append(h("div", { class: "picker-info" }, "目前沒有任何書籤。按「新增書籤」建立。"));
    items.forEach((b, i) => {
      const pos = ed.bookmarkPosition(b);
      const handle = h("span", { class: "bm-handle", draggable: "true", title: "拖曳以調整順序（子項會一起移動）" }, "⋮⋮");
      const row = h(
        "div",
        { class: "bm-row" },
        handle,
        h("div", { class: "bm-indent", style: `width:${(b.level - 1) * 22}px` }),
        h("input", {
          type: "text",
          class: "bm-title",
          value: b.title,
          placeholder: "書籤標題",
          oninput: (e) => (b.title = e.target.value),
        }),
        h("span", { class: "bm-target-label" }, "第"),
        h("input", {
          type: "number",
          class: "bm-target",
          min: "1",
          max: String(total),
          value: pos === null ? "" : String(pos),
          placeholder: "—",
          onchange: (e) => {
            const n = Number(e.target.value);
            b.target = e.target.value !== "" && Number.isInteger(n) && n >= 1 && n <= total ? ed.pages[n - 1].uid : null;
            render();
          },
        }),
        h("span", { class: "bm-target-label" }, "頁"),
        h("button", { class: "btn-icon", title: "升階（往左）", onclick: () => update(shiftBookmarkLevel(items, i, -1)) }, "⇤"),
        h("button", { class: "btn-icon", title: "降階（往右）", onclick: () => update(shiftBookmarkLevel(items, i, 1)) }, "⇥"),
        h("button", { class: "btn-icon", title: "刪除（子項會升一階）", onclick: () => update(removeBookmark(items, i)) }, "🗑"),
        pos === null ? h("span", { class: "bm-warn" }, b.target === null ? "未指定目標頁" : "目標頁已不存在") : null
      );
      handle.addEventListener("dragstart", (e) => {
        dragIndex = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        row.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => {
        dragIndex = null;
        list.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after"));
      });
      row.addEventListener("dragover", (e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        list.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
        row.classList.add(after ? "drop-after" : "drop-before");
      });
      row.addEventListener("drop", (e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        const from = dragIndex;
        dragIndex = null;
        update(moveBookmarkSubtree(items, from, i, after));
      });
      list.append(row);
    });
  }
  render();

  const firstSelected = ed.pages.find((p) => ed.selection.has(p.uid));
  const addBtn = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        const target = (firstSelected || ed.pages[0]).uid;
        items.push({ id: nextId++, level: 1, title: "新書籤", target });
        render();
        list.scrollTop = list.scrollHeight;
      },
    },
    "＋ 新增書籤"
  );

  openModal({
    title: "編輯書籤",
    body: h(
      "div",
      {},
      h("div", { class: "inline-row" }, addBtn, h("span", { class: "picker-info" }, firstSelected ? "新書籤預設指向目前選取的第一個頁面" : "新書籤預設指向第 1 頁")),
      list,
      h(
        "div",
        { class: "picker-info" },
        "拖曳 ⋮⋮ 調整順序；⇤ ⇥ 調整層級（子項會一起移動）；「第 N 頁」可改書籤指向的頁面。頁碼以目前畫面順序為準，之後重新排序頁面時書籤會自動跟著頁面。"
      ),
      err
    ),
    actions: [
      { label: "取消" },
      {
        label: "套用",
        primary: true,
        onClick: () => {
          try {
            ed.applyBookmarks(items);
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
  });
}

// ---------- image stamps ----------

function edOpenStampDialog() {
  const total = ed.pages.length;
  let stamps = ed.stamps.map((st) => ({ ...st, scope: { ...st.scope, uids: [...(st.scope.uids || [])] } }));
  let nextId = Math.max(0, ...stamps.map((st) => st.id)) + 1;
  let selectedId = stamps.length ? stamps[0].id : null;
  let cur = ed.selection.size ? Math.max(0, ed.positionOf([...ed.selection][0])) : 0;
  const uploaded = [];
  let objectUrl = null;
  let loadToken = 0;
  const err = h("div", { class: "dialog-error" });

  const selected = () => stamps.find((st) => st.id === selectedId) || null;

  // ----- stage: the page with draggable stamps on top -----
  const pageImg = h("img", { class: "stamp-page", alt: "" });
  const stage = h("div", { class: "stamp-stage" }, pageImg);
  const stageWrap = h("div", { class: "stamp-stage-wrap" }, stage);
  const curInput = h("input", { type: "number", min: "1", max: String(total), value: String(cur + 1) });
  const MAX_W = 520;
  const MAX_H = 560;

  function fitStage() {
    const size = edPageSize(ed.pages[cur]);
    const vis = ed.pages[cur].rot % 180 !== 0 ? { w: size.h, h: size.w } : size;
    const k = Math.min(MAX_W / vis.w, MAX_H / vis.h);
    stage.style.width = `${vis.w * k}px`;
    stage.style.height = `${vis.h * k}px`;
  }

  async function loadPage() {
    const mine = ++loadToken;
    fitStage();
    try {
      const res = await fetch(`${API}/edit/preview?index=${cur}&w=900`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ed.recipe("preview.pdf", { page_labels: [], stamps: [] })),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      const url = URL.createObjectURL(await res.blob());
      if (mine !== loadToken) return URL.revokeObjectURL(url);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = url;
      pageImg.src = url;
    } catch (e) {
      err.textContent = `頁面預覽失敗：${e.message}`;
    }
    drawStamps();
  }

  function goto(n) {
    cur = Math.min(Math.max(n, 0), total - 1);
    curInput.value = String(cur + 1);
    loadPage();
    renderControls();
  }

  // ----- drawing + interaction -----
  function drawStamps() {
    stage.querySelectorAll(".stamp-box").forEach((el) => el.remove());
    const rect = () => stage.getBoundingClientRect();
    for (const st of stamps) {
      if (!ed.stampAppliesTo(st, cur)) continue;
      const active = st.id === selectedId;
      const img = h("img", { src: `${API}/files/${st.file}/raw`, alt: st.name, draggable: "false" });
      const box = h("div", { class: "stamp-box" + (active ? " active" : "") }, img);
      box.style.left = `${st.cx * 100}%`;
      box.style.top = `${st.cy * 100}%`;
      box.style.width = `${st.w * 100}%`;
      box.style.opacity = String(st.opacity);
      box.style.transform = `translate(-50%, -50%) rotate(${st.rot}deg)`;
      box.addEventListener("pointerdown", (e) => {
        if (!active) {
          selectedId = st.id;
          drawStamps();
          renderControls();
          return;
        }
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy };
        trackPointer((ev) => {
          const r = rect();
          st.cx = Math.min(1.5, Math.max(-0.5, start.cx + (ev.clientX - start.x) / r.width));
          st.cy = Math.min(1.5, Math.max(-0.5, start.cy + (ev.clientY - start.y) / r.height));
          box.style.left = `${st.cx * 100}%`;
          box.style.top = `${st.cy * 100}%`;
        });
      });
      if (active) {
        const resize = h("span", { class: "stamp-handle resize-h", title: "拖曳縮放" });
        const rotate = h("span", { class: "stamp-handle rotate-h", title: "拖曳旋轉" });
        resize.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = rect();
          const rad = (st.rot * Math.PI) / 180;
          const start = { x: e.clientX, y: e.clientY, wpx: st.w * r.width };
          trackPointer((ev) => {
            const dx = ev.clientX - start.x;
            const dy = ev.clientY - start.y;
            const local = dx * Math.cos(rad) + dy * Math.sin(rad); // movement along the stamp's own x axis
            st.w = Math.min(3, Math.max(0.02, (start.wpx + 2 * local) / r.width));
            box.style.width = `${st.w * 100}%`;
            syncSliders();
          });
        });
        rotate.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          trackPointer((ev) => {
            const r = rect();
            const centerX = r.left + st.cx * r.width;
            const centerY = r.top + st.cy * r.height;
            let deg = (Math.atan2(ev.clientY - centerY, ev.clientX - centerX) * 180) / Math.PI + 90;
            deg = ((deg + 540) % 360) - 180; // -180..180
            if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
            st.rot = Math.round(deg * 10) / 10;
            box.style.transform = `translate(-50%, -50%) rotate(${st.rot}deg)`;
            syncSliders();
          });
        });
        box.append(resize, rotate);
      }
      stage.append(box);
    }
  }

  function trackPointer(onMove) {
    const move = (ev) => onMove(ev);
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ----- side panel -----
  const stampList = h("div", { class: "stamp-list" });
  const controls = h("div", { class: "stamp-controls" });
  let sizeInput, rotInput, opacityInput;

  function syncSliders() {
    const st = selected();
    if (!st || !sizeInput) return;
    sizeInput.value = String(Math.round(st.w * 100));
    rotInput.value = String(Math.round(st.rot));
    opacityInput.value = String(Math.round(st.opacity * 100));
  }

  function renderList() {
    stampList.innerHTML = "";
    if (!stamps.length) stampList.append(h("div", { class: "picker-info" }, "尚未加入任何章。請先上傳圖片（建議使用透明背景的 PNG）。"));
    for (const st of stamps) {
      stampList.append(
        h(
          "div",
          {
            class: "stamp-item" + (st.id === selectedId ? " active" : ""),
            onclick: () => {
              selectedId = st.id;
              renderList();
              renderControls();
              drawStamps();
            },
          },
          h("img", { src: `${API}/files/${st.file}/raw`, alt: "" }),
          h("span", { class: "stamp-name", title: st.name }, st.name),
          h(
            "button",
            {
              class: "btn-icon",
              title: "移除這個章",
              onclick: (e) => {
                e.stopPropagation();
                stamps = stamps.filter((x) => x.id !== st.id);
                if (selectedId === st.id) selectedId = stamps.length ? stamps[0].id : null;
                renderList();
                renderControls();
                drawStamps();
              },
            },
            "✕"
          )
        )
      );
    }
  }

  function renderControls() {
    controls.innerHTML = "";
    const st = selected();
    if (!st) {
      sizeInput = rotInput = opacityInput = null;
      return;
    }
    sizeInput = h("input", { type: "range", min: "2", max: "100", value: String(Math.round(st.w * 100)) });
    sizeInput.addEventListener("input", () => {
      st.w = Number(sizeInput.value) / 100;
      drawStamps();
    });
    rotInput = h("input", { type: "number", min: "-180", max: "180", value: String(Math.round(st.rot)) });
    rotInput.addEventListener("input", () => {
      st.rot = Math.max(-360, Math.min(360, Number(rotInput.value) || 0));
      drawStamps();
    });
    opacityInput = h("input", { type: "range", min: "10", max: "100", value: String(Math.round(st.opacity * 100)) });
    opacityInput.addEventListener("input", () => {
      st.opacity = Number(opacityInput.value) / 100;
      drawStamps();
    });

    const rangeInput = h("input", {
      type: "text",
      placeholder: "例如 1-3,5",
      value: st.scope.mode === "pages" ? edCompactRange(ed.stampPositions(st)) : "",
    });
    const radio = (value, label, extra) =>
      h(
        "label",
        { class: "scope-row" },
        h("input", {
          type: "radio",
          name: "stamp-scope",
          value,
          checked: stampScopeKind(st) === value,
          onchange: () => setScope(value),
        }),
        label,
        extra
      );
    function setScope(kind) {
      err.textContent = "";
      if (kind === "all") st.scope = ed.stampScope("all");
      else if (kind === "current") st.scope = ed.stampScope("current", [cur + 1]);
      else {
        const nums = rangeInput.value.trim() ? safeRange(rangeInput.value) : [cur + 1];
        st.scope = ed.stampScope("range", nums);
        if (!rangeInput.value.trim()) rangeInput.value = edCompactRange(nums);
      }
      drawStamps();
    }
    function safeRange(text) {
      try {
        return edParseRange(text, total, "頁碼");
      } catch (e) {
        err.textContent = e.message;
        return [];
      }
    }
    rangeInput.addEventListener("input", () => {
      const nums = safeRange(rangeInput.value);
      if (!nums.length) return;
      err.textContent = "";
      st.scope = ed.stampScope("range", nums);
      controls.querySelector('input[value="range"]').checked = true;
      drawStamps();
    });

    controls.append(
      h("div", { class: "section-title" }, `調整：${st.name}`),
      h("label", { class: "field" }, "大小（佔頁面寬度的百分比）", sizeInput),
      h("label", { class: "field" }, "旋轉角度（度，順時針為正）", rotInput),
      h("label", { class: "field" }, "透明度", opacityInput),
      h("div", { class: "section-title" }, "套用範圍"),
      radio("all", "全部頁面"),
      radio("current", `只有目前預覽的頁面（第 ${cur + 1} 頁）`),
      radio("range", "指定頁面：", rangeInput)
    );
  }

  async function addStampFile(file) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) {
      err.textContent = "請選擇 PNG 或 JPG 圖片";
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const item = await apiFetch(`${API}/upload`, { method: "POST", body: form });
      uploaded.push(item.id);
      if (item.status !== "ok" || item.type !== "image") {
        err.textContent = item.error_message || "無法使用這個檔案";
        return;
      }
      err.textContent = "";
      const st = {
        id: nextId++,
        file: item.id,
        name: item.name,
        cx: 0.5,
        cy: 0.5,
        w: 0.25,
        rot: 0,
        opacity: 1,
        scope: { mode: "all" },
      };
      stamps.push(st);
      selectedId = st.id;
      renderList();
      renderControls();
      drawStamps();
    } catch (e) {
      err.textContent = `上傳失敗：${e.message}`;
    }
  }

  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg" });
  fileInput.addEventListener("change", () => {
    addStampFile(fileInput.files[0]);
    fileInput.value = "";
  });
  curInput.addEventListener("change", () => goto((Number(curInput.value) || 1) - 1));

  const body = h(
    "div",
    { class: "stamp-layout" },
    h(
      "div",
      { class: "stamp-side" },
      h("label", { class: "field" }, "上傳章或簽名檔（PNG 透明背景最佳）", fileInput),
      stampList,
      controls,
      err
    ),
    h(
      "div",
      { class: "stamp-main" },
      h(
        "div",
        { class: "inline-row stamp-nav" },
        h("button", { class: "btn", onclick: () => goto(cur - 1) }, "◀"),
        "第",
        curInput,
        `/ ${total} 頁`,
        h("button", { class: "btn", onclick: () => goto(cur + 1) }, "▶"),
        h("span", { class: "picker-info" }, "拖曳章移動；拖曳右下角縮放；拖曳上方圓點旋轉（按住 Shift 以 15° 為單位）")
      ),
      stageWrap
    )
  );

  const dialog = openModal({
    title: "蓋章",
    body,
    actions: [
      { label: "取消" },
      {
        label: "套用",
        primary: true,
        onClick: () => {
          try {
            ed.applyStamps(stamps);
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
    onClose: () => {
      loadToken++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // images uploaded in this dialog that ended up unused are discarded again
      uploaded.forEach((id) => {
        if (ed.referencesFile(id)) return;
        apiFetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {});
      });
    },
  });
  dialog.backdrop.querySelector(".modal").classList.add("wide");
  renderList();
  renderControls();
  loadPage();
}

// ---------- single page preview ----------

function edOpenPreview(startUid) {
  let pos = ed.positionOf(startUid);
  if (pos < 0) return;
  const stageImg = h("img", { alt: "" });
  const label = h("span", {});
  const prev = h("button", { class: "preview-nav", title: "上一頁", onclick: () => go(-1) }, "◀");
  const next = h("button", { class: "preview-nav", title: "下一頁", onclick: () => go(1) }, "▶");
  const stage = h("div", { class: "preview-stage" }, prev, stageImg, next);

  const boxW = Math.min(760, window.innerWidth - 220);
  const boxH = Math.min(620, window.innerHeight - 220);

  let objectUrl = null;
  let showToken = 0;

  async function overlayUrl() {
    const res = await fetch(`${API}/edit/preview?index=${pos}&w=1100`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ed.recipe("preview.pdf", { page_labels: [] })),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return URL.createObjectURL(await res.blob());
  }

  function show() {
    const page = ed.pages[pos];
    const token = ++showToken;
    if (ed.hasOverlays) {
      // The server already applied the page rotation and overlays: show it as-is.
      const size = edPageSize(page);
      const vis = page.rot % 180 !== 0 ? { w: size.h, h: size.w } : size;
      const scale = Math.min(boxW / vis.w, boxH / vis.h);
      stageImg.style.width = `${vis.w * scale}px`;
      stageImg.style.height = `${vis.h * scale}px`;
      stageImg.style.transform = "none";
      overlayUrl()
        .then((url) => {
          if (token !== showToken) return URL.revokeObjectURL(url);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = url;
          stageImg.src = url;
        })
        .catch((err) => showError(`預覽失敗：${err.message}`));
    } else {
      const fit = edFit(page, boxW, boxH);
      stageImg.src = edImageUrl(page, 1100);
      stageImg.style.width = `${fit.w}px`;
      stageImg.style.height = `${fit.h}px`;
      stageImg.style.transform = `rotate(${page.rot}deg)`;
    }
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
    onClose: () => {
      document.removeEventListener("keydown", onKey);
      showToken++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  });
}

// ---------- export ----------

function edSummaryLines() {
  const t = ed.summary();
  const lines = [`原始檔案 ${t.originalPages} 頁 → 輸出 ${t.outputPages} 頁`];
  if (t.foreignPages) lines.push(`其中 ${t.foreignPages} 頁來自其他 PDF`);
  if (t.rotatedPages) lines.push(`${t.rotatedPages} 頁已旋轉`);
  if (t.numbering) {
    const fmt = ED_NUMBER_FORMATS.find((f) => f[0] === t.numbering.fmt)[1];
    lines.push(`蓋印頁碼：${fmt}，從第 ${t.numbering.startPage} 頁開始`);
  }
  if (t.stamps) lines.push(`蓋章：${t.stamps} 個` + (t.lostStamps ? `（其中 ${t.lostStamps} 個的頁面已不存在，不會蓋上）` : ""));
  if (t.labelRules) lines.push(`頁碼標籤：${t.labelRules} 條規則`);
  if (t.bookmarks) lines.push(`書籤：${t.bookmarks} 個` + (t.lostBookmarks ? `（其中 ${t.lostBookmarks} 個沒有指向有效頁面）` : ""));
  return lines;
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
      h("div", { class: "summary" }, edSummaryLines().map((t) => h("div", {}, t))),
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
      body: JSON.stringify(ed.recipe(outputName)),
    });
    await watchJob(job_id, "edit", saveTarget);
  } catch (err) {
    showError(`匯出失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- init ----------

function edTypingInField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

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
  document.getElementById("edit-undo").addEventListener("click", () => ed.undo());
  document.getElementById("edit-redo").addEventListener("click", () => ed.redo());
  document.getElementById("edit-move-btn").addEventListener("click", edOpenMoveDialog);
  document.getElementById("edit-insert-btn").addEventListener("click", edOpenInsertDialog);
  document.getElementById("edit-replace-btn").addEventListener("click", edOpenReplaceDialog);
  document.getElementById("edit-delete-btn").addEventListener("click", edOpenDeleteDialog);
  document.getElementById("edit-numbering-btn").addEventListener("click", edOpenNumberingDialog);
  document.getElementById("edit-bookmark-btn").addEventListener("click", edOpenBookmarkDialog);
  document.getElementById("edit-stamp-btn").addEventListener("click", edOpenStampDialog);
  document.querySelectorAll("#edit-toolbar [data-rotate]").forEach((btn) => {
    btn.addEventListener("click", () => ed.rotate(Number(btn.dataset.rotate)));
  });
  edBindGridDrop();
  setInterval(edHeartbeat, ED_HEARTBEAT_MS);

  document.addEventListener("keydown", (e) => {
    if (!ed || !document.getElementById("tab-edit").classList.contains("active") || edTypingInField(e)) return;
    if (document.querySelector(".modal-backdrop")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? ed.redo() : ed.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      ed.redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      edSelectAll();
    } else if (e.key === "Delete" && !mod) {
      e.preventDefault();
      edDeleteSelection();
    }
  });
});
