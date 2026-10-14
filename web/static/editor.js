// ---------- page editor ----------
// The document being edited is just an ordered list of page references
// ({src file, page index, extra rotation}). Every operation edits that list;
// a new PDF is only built on the server when the user exports.

const ED_BOX = 150; // thumbnail box (CSS px)
const ED_THUMB_W = 280; // thumbnail image width requested from the server
const ED_HISTORY_LIMIT = 100;

const ed = {
  sources: {}, // fileId -> {id, name, page_count, status, pages:[{w,h,rotation}]}
  baseId: null,
  pages: [], // [{uid, src, idx, rot}]
  selection: new Set(), // uids
  anchor: null, // uid used as the start of a Shift range
  nextUid: 1,
  history: [], // JSON snapshots of the document state
  hIndex: -1,
  dragUids: null, // uids being dragged while a reorder drag is active
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

// actions: [{label, primary, onClick(close) -> true to keep the dialog open}]
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

function edSelectedPositions() {
  return ed.pages.map((p, i) => (ed.selection.has(p.uid) ? i + 1 : 0)).filter(Boolean);
}

// ---------- history (undo / redo) ----------

function edSnapshot() {
  return JSON.stringify({ pages: ed.pages });
}

function edUpdateHistoryButtons() {
  document.getElementById("edit-undo").disabled = ed.hIndex <= 0;
  document.getElementById("edit-redo").disabled = ed.hIndex >= ed.history.length - 1;
}

function edResetHistory() {
  ed.history = [edSnapshot()];
  ed.hIndex = 0;
  edUpdateHistoryButtons();
}

// Call after every document mutation.
function edCommit() {
  ed.history.length = ed.hIndex + 1;
  ed.history.push(edSnapshot());
  if (ed.history.length > ED_HISTORY_LIMIT) ed.history.shift();
  ed.hIndex = ed.history.length - 1;
  edUpdateHistoryButtons();
  edRender();
}

function edGoto(index) {
  if (index < 0 || index >= ed.history.length) return;
  ed.hIndex = index;
  ed.pages = JSON.parse(ed.history[index]).pages;
  const alive = new Set(ed.pages.map((p) => p.uid));
  ed.selection = new Set([...ed.selection].filter((u) => alive.has(u)));
  edUpdateHistoryButtons();
  edRender();
}

const edUndo = () => edGoto(ed.hIndex - 1);
const edRedo = () => edGoto(ed.hIndex + 1);

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
  if (ed.history.length > 1 && !confirm("目前的編輯內容尚未匯出，確定要改開另一個檔案嗎？")) return;
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
  const previous = Object.keys(ed.sources);
  ed.sources = { [item.id]: { id: item.id, name: item.name, page_count: item.page_count, status: item.status, pages: null } };
  ed.baseId = item.id;
  await edLoadInfo(item.id);
  ed.nextUid = 1;
  ed.pages = Array.from({ length: item.page_count }, (_, i) => edNewPage(item.id, i));
  ed.selection = new Set();
  ed.anchor = null;
  edResetHistory();
  hideResult("edit-result");
  document.getElementById("edit-workspace").classList.remove("hidden");
  edRender();
  previous.filter((id) => id !== item.id).forEach((id) => apiFetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {}));
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

function edSelectUids(uids) {
  ed.selection = new Set(uids);
  ed.anchor = uids.length ? uids[0] : null;
  edRefreshSelection();
}

const edSelectAll = () => edSelectUids(ed.pages.map((p) => p.uid));
const edSelectNone = () => edSelectUids([]);

// ---------- drag to reorder ----------

function edClearDropMarks() {
  document.querySelectorAll("#edit-grid .drop-before, #edit-grid .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
  document.getElementById("edit-grid").classList.remove("drop-end");
}

// Moves the pages `uids` (kept in their current relative order) next to `targetUid`;
// targetUid === null means "to the very end".
function edMoveBlock(uids, targetUid, after) {
  const set = new Set(uids);
  if (targetUid !== null && set.has(targetUid)) return;
  const moving = ed.pages.filter((p) => set.has(p.uid));
  const rest = ed.pages.filter((p) => !set.has(p.uid));
  const at = targetUid === null ? rest.length : rest.findIndex((p) => p.uid === targetUid) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.every((p, i) => p.uid === ed.pages[i].uid)) return;
  ed.pages = next;
  edCommit();
}

function edBindDrag(cell, page) {
  cell.addEventListener("dragstart", (e) => {
    if (!ed.selection.has(page.uid)) edSelectUids([page.uid]);
    ed.dragUids = ed.pages.filter((p) => ed.selection.has(p.uid)).map((p) => p.uid);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(page.uid));
    document.querySelectorAll("#edit-grid .page-cell.selected").forEach((c) => c.classList.add("dragging"));
  });
  cell.addEventListener("dragend", () => {
    ed.dragUids = null;
    document.querySelectorAll("#edit-grid .dragging").forEach((c) => c.classList.remove("dragging"));
    edClearDropMarks();
  });
  cell.addEventListener("dragover", (e) => {
    if (!ed.dragUids) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cell.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    edClearDropMarks();
    cell.classList.add(after ? "drop-after" : "drop-before");
  });
  cell.addEventListener("drop", (e) => {
    if (!ed.dragUids) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cell.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const uids = ed.dragUids;
    ed.dragUids = null;
    edClearDropMarks();
    edMoveBlock(uids, page.uid, after);
  });
}

function edBindGridDrop() {
  const grid = document.getElementById("edit-grid");
  grid.addEventListener("dragover", (e) => {
    if (!ed.dragUids) return;
    e.preventDefault();
    edClearDropMarks();
    grid.classList.add("drop-end");
  });
  grid.addEventListener("dragleave", (e) => {
    if (e.target === grid) grid.classList.remove("drop-end");
  });
  grid.addEventListener("drop", (e) => {
    if (!ed.dragUids) return;
    e.preventDefault();
    const uids = ed.dragUids;
    ed.dragUids = null;
    edClearDropMarks();
    edMoveBlock(uids, null, false);
  });
}

// ---------- rotate ----------

// Applies to the selection, or to the whole document when nothing is selected.
function edRotate(degrees) {
  const targets = ed.selection.size ? ed.pages.filter((p) => ed.selection.has(p.uid)) : ed.pages;
  targets.forEach((p) => {
    p.rot = (p.rot + degrees) % 360;
  });
  edCommit();
}

// ---------- move by page number ----------

// Moves pages `nums` (1-based, current numbering) to just after page `after` (0 = front).
function edMovePages(nums, after) {
  const total = ed.pages.length;
  if (!Number.isInteger(after) || after < 0 || after > total) throw new Error(`目標位置需介於 0 到 ${total}`);
  const moving = nums.map((n) => ed.pages[n - 1]);
  const movingSet = new Set(moving.map((p) => p.uid));
  const anchor = after > 0 ? ed.pages[after - 1] : null;
  if (anchor && movingSet.has(anchor.uid)) throw new Error(`第 ${after} 頁本身也在要移動的頁面中，請改選其他位置`);
  const rest = ed.pages.filter((p) => !movingSet.has(p.uid));
  const at = anchor ? rest.findIndex((p) => p.uid === anchor.uid) + 1 : 0;
  ed.pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  edCommit();
  edSelectUids(moving.map((p) => p.uid));
}

function edOpenMoveDialog() {
  const total = ed.pages.length;
  const pos = edSelectedPositions();
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
            edMovePages(edParseRange(fromInput.value, total), Number(toInput.value));
          } catch (e) {
            err.textContent = e.message;
            return true;
          }
        },
      },
    ],
  });
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
    ed.sources[item.id] = { id: item.id, name: item.name, page_count: item.page_count, status: item.status, pages: null };
    await edLoadInfo(item.id);
    picked = ed.sources[item.id];
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
        if (ed.history.some((snap) => snap.includes(`"src":"${id}"`))) return;
        delete ed.sources[id];
        apiFetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {});
      });
    },
  };
}

// ---------- insert another PDF ----------

function edInsertPages(source, nums, after) {
  const total = ed.pages.length;
  if (!Number.isInteger(after) || after < 0 || after > total) throw new Error(`插入位置需介於 0 到 ${total}`);
  const fresh = nums.map((n) => edNewPage(source.id, n - 1));
  ed.pages = [...ed.pages.slice(0, after), ...fresh, ...ed.pages.slice(after)];
  edCommit();
  edSelectUids(fresh.map((p) => p.uid));
}

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
            edInsertPages(src, nums, Number(afterInput.value));
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

// pairs: [{pos (1-based current position), srcIdx (0-based)}]
function edApplyReplace(source, pairs) {
  const fresh = [];
  pairs.forEach(({ pos, srcIdx }) => {
    const page = edNewPage(source.id, srcIdx, 0);
    ed.pages[pos - 1] = page;
    fresh.push(page.uid);
  });
  edCommit();
  edSelectUids(fresh);
}

function edOpenReplaceDialog() {
  const total = ed.pages.length;
  const pos = edSelectedPositions();
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
      { label: "確認取代", primary: true, onClick: () => { edApplyReplace(source, pairs); } },
    ],
    onClose: () => picker.cleanup(),
  });
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
  document.getElementById("edit-undo").addEventListener("click", edUndo);
  document.getElementById("edit-redo").addEventListener("click", edRedo);
  document.getElementById("edit-move-btn").addEventListener("click", edOpenMoveDialog);
  document.getElementById("edit-insert-btn").addEventListener("click", edOpenInsertDialog);
  document.getElementById("edit-replace-btn").addEventListener("click", edOpenReplaceDialog);
  document.querySelectorAll("#edit-toolbar [data-rotate]").forEach((btn) => {
    btn.addEventListener("click", () => edRotate(Number(btn.dataset.rotate)));
  });
  edBindGridDrop();

  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("tab-edit").classList.contains("active") || edTypingInField(e)) return;
    if (document.querySelector(".modal-backdrop")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? edRedo() : edUndo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      edRedo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      edSelectAll();
    }
  });
});
