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
  labels: [], // page-label rules [{start (0-based), style, prefix, first}]
  bookmarks: [], // outline entries [{id, level, title, target (page uid | null)}]
  nextBookmarkId: 1,
  stamps: [], // image stamps [{id, file, name, cx, cy, w, rot, opacity, scope:{mode:"all"}|{mode:"pages",uids}}]
  numbering: null, // printed page numbers {v_pos,h_pos,fmt,start_page,start_number,font_size,margin} | null
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
  return JSON.stringify({
    pages: ed.pages,
    labels: ed.labels,
    numbering: ed.numbering,
    bookmarks: ed.bookmarks,
    stamps: ed.stamps,
  });
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
  const snap = JSON.parse(ed.history[index]);
  ed.pages = snap.pages;
  ed.labels = snap.labels;
  ed.numbering = snap.numbering;
  ed.bookmarks = snap.bookmarks;
  ed.stamps = snap.stamps || [];
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
  const info = await edLoadInfo(item.id);
  ed.nextUid = 1;
  ed.pages = Array.from({ length: item.page_count }, (_, i) => edNewPage(item.id, i));
  ed.labels = (info.labels || []).map((l) => ({
    start: l.startpage || 0,
    style: l.style || "",
    prefix: l.prefix || "",
    first: l.firstpagenum || 1,
  }));
  ed.numbering = null;
  ed.stamps = [];
  ed.nextBookmarkId = 1;
  ed.bookmarks = (info.toc || []).map((t) => ({
    id: ed.nextBookmarkId++,
    level: t.level,
    title: t.title,
    target: t.page >= 1 && t.page <= item.page_count ? ed.pages[t.page - 1].uid : null,
  }));
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
    const old = ed.pages[pos - 1];
    ed.bookmarks.forEach((b) => {
      if (b.target === old.uid) b.target = page.uid;
    });
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
  const stamp = ed.numbering
    ? { ...ed.numbering }
    : { v_pos: "bottom", h_pos: "center", fmt: "number", start_page: 1, start_number: 1, font_size: 10, margin: 28 };
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
      const body = edRecipe("preview.pdf", { page_labels: [], page_numbers: stampOn ? { ...stamp } : null });
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

  const fail = (message) => {
    err.textContent = message;
    return true;
  };

  const dialog = openModal({
    title: "頁碼設定",
    body,
    actions: [
      { label: "取消" },
      {
        label: "套用",
        primary: true,
        onClick: () => {
          for (const r of rules) {
            if (!Number.isInteger(r.start) || r.start < 0 || r.start >= total) return fail(`標籤規則的起始頁需介於 1 到 ${total}`);
            if (!Number.isInteger(r.first) || r.first < 1) return fail("標籤規則的起始號碼需大於等於 1");
          }
          if (new Set(rules.map((r) => r.start)).size !== rules.length) return fail("不同規則不能從同一頁開始");
          if (stampOn) {
            if (!Number.isInteger(stamp.start_page) || stamp.start_page < 1 || stamp.start_page > total)
              return fail(`蓋印的起始頁需介於 1 到 ${total}`);
            if (!Number.isFinite(stamp.start_number) || stamp.start_number < 0) return fail("起始號碼不可為負數");
            if (!Number.isFinite(stamp.font_size) || stamp.font_size < 4 || stamp.font_size > 72) return fail("字型大小需介於 4–72");
          }
          ed.labels = rules.map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
          ed.numbering = stampOn ? { ...stamp } : null;
          edCommit();
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

  const subtreeEndIn = (arr, i) => {
    let j = i + 1;
    while (j < arr.length && arr[j].level > arr[i].level) j++;
    return j;
  };
  const posOfTarget = (t) => {
    const i = t === null ? -1 : ed.pages.findIndex((p) => p.uid === t);
    return i >= 0 ? i + 1 : null;
  };

  function shiftLevel(i, delta) {
    const end = subtreeEndIn(items, i);
    const maxLevel = i === 0 ? 1 : items[i - 1].level + 1;
    const target = Math.max(1, Math.min(items[i].level + delta, maxLevel));
    const applied = target - items[i].level;
    if (!applied) return;
    for (let k = i; k < end; k++) items[k].level = Math.max(1, items[k].level + applied);
    render();
  }

  function removeItem(i) {
    const end = subtreeEndIn(items, i);
    for (let k = i + 1; k < end; k++) items[k].level = Math.max(1, items[k].level - 1); // promote children
    items.splice(i, 1);
    render();
  }

  // Moves bookmark `from` together with its children next to row `toRow`.
  function moveSubtree(from, toRow, after) {
    const end = subtreeEndIn(items, from);
    if (toRow >= from && toRow < end) return; // dropped inside itself
    const block = items.slice(from, end);
    const rest = [...items.slice(0, from), ...items.slice(end)];
    const row = toRow < from ? toRow : toRow - block.length;
    const at = after ? subtreeEndIn(rest, row) : row;
    items = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    render();
  }

  function render() {
    list.innerHTML = "";
    if (!items.length) list.append(h("div", { class: "picker-info" }, "目前沒有任何書籤。按「新增書籤」建立。"));
    items.forEach((b, i) => {
      const pos = posOfTarget(b.target);
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
        h("button", { class: "btn-icon", title: "升階（往左）", onclick: () => shiftLevel(i, -1) }, "⇤"),
        h("button", { class: "btn-icon", title: "降階（往右）", onclick: () => shiftLevel(i, 1) }, "⇥"),
        h("button", { class: "btn-icon", title: "刪除（子項會升一階）", onclick: () => removeItem(i) }, "🗑"),
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
        moveSubtree(from, i, after);
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
          const blank = items.findIndex((b) => !b.title.trim());
          if (blank >= 0) {
            err.textContent = `第 ${blank + 1} 個書籤沒有標題`;
            return true;
          }
          ed.bookmarks = items.map((b) => ({ ...b, title: b.title.trim() }));
          edCommit();
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
  let cur = ed.selection.size ? Math.max(0, edPositionOf([...ed.selection][0])) : 0;
  const uploaded = [];
  let objectUrl = null;
  let loadToken = 0;
  const err = h("div", { class: "dialog-error" });

  const selected = () => stamps.find((st) => st.id === selectedId) || null;
  const appliesTo = (st, pageIndex) => st.scope.mode === "all" || st.scope.uids.includes(ed.pages[pageIndex].uid);

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
        body: JSON.stringify(edRecipe("preview.pdf", { page_labels: [], stamps: [] })),
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
      if (!appliesTo(st, cur)) continue;
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
      value: st.scope.mode === "pages" ? edCompactRange(st.scope.uids.map((u) => edPositionOf(u) + 1).filter((n) => n > 0).sort((a, b) => a - b)) : "",
    });
    const radio = (value, label, extra) =>
      h(
        "label",
        { class: "scope-row" },
        h("input", {
          type: "radio",
          name: "stamp-scope",
          value,
          checked: scopeKind(st) === value,
          onchange: () => setScope(value),
        }),
        label,
        extra
      );
    const scopeKind = (x) => {
      if (x.scope.mode === "all") return "all";
      return x.scope.custom ? "range" : "current";
    };
    function setScope(kind) {
      err.textContent = "";
      if (kind === "all") st.scope = { mode: "all" };
      else if (kind === "current") st.scope = { mode: "pages", uids: [ed.pages[cur].uid] };
      else {
        const nums = rangeInput.value.trim() ? safeRange(rangeInput.value) : [cur + 1];
        st.scope = { mode: "pages", custom: true, uids: nums.map((n) => ed.pages[n - 1].uid) };
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
      st.scope = { mode: "pages", custom: true, uids: nums.map((n) => ed.pages[n - 1].uid) };
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
          for (const st of stamps) {
            if (st.scope.mode === "pages" && !st.scope.uids.length) {
              err.textContent = `「${st.name}」沒有指定任何頁面`;
              return true;
            }
          }
          ed.stamps = stamps.map((st) => {
            const { custom, ...scope } = st.scope;
            return { ...st, scope };
          });
          edCommit();
        },
      },
    ],
    onClose: () => {
      loadToken++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // images uploaded in this dialog that ended up unused are discarded again
      uploaded.forEach((id) => {
        if (ed.history.some((snap) => snap.includes(`"file":"${id}"`))) return;
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
  let pos = edPositionOf(startUid);
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
      body: JSON.stringify(edRecipe("preview.pdf", { page_labels: [] })),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return URL.createObjectURL(await res.blob());
  }

  function show() {
    const page = ed.pages[pos];
    const token = ++showToken;
    if (edHasOverlays()) {
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

function edSummary() {
  const base = ed.sources[ed.baseId];
  const foreign = ed.pages.filter((p) => p.src !== ed.baseId).length;
  const rotated = ed.pages.filter((p) => p.rot).length;
  const parts = [`原始檔案 ${base.page_count} 頁 → 輸出 ${ed.pages.length} 頁`];
  if (foreign) parts.push(`其中 ${foreign} 頁來自其他 PDF`);
  if (rotated) parts.push(`${rotated} 頁已旋轉`);
  if (ed.numbering) {
    const fmt = ED_NUMBER_FORMATS.find((f) => f[0] === ed.numbering.fmt)[1];
    parts.push(`蓋印頁碼：${fmt}，從第 ${ed.numbering.start_page} 頁開始`);
  }
  if (ed.stamps.length) parts.push(`蓋章：${ed.stamps.length} 個`);
  if (ed.labels.length) parts.push(`頁碼標籤：${ed.labels.length} 條規則`);
  if (ed.bookmarks.length) {
    const lost = edBookmarksForExport().filter((b) => b.page < 0).length;
    parts.push(`書籤：${ed.bookmarks.length} 個` + (lost ? `（其中 ${lost} 個沒有指向有效頁面）` : ""));
  }
  return parts;
}

function edRecipe(outputName, overrides = {}) {
  return {
    pages: ed.pages.map((p) => ({ src: p.src, idx: p.idx, rot: p.rot })),
    output_name: outputName,
    page_labels: ed.labels,
    page_numbers: ed.numbering,
    bookmarks: edBookmarksForExport(),
    stamps: edStampsForExport(),
    ...overrides,
  };
}

// Stamps limited to chosen pages are stored by page identity; the server wants output positions.
function edStampsForExport() {
  const position = new Map(ed.pages.map((p, i) => [p.uid, i]));
  const out = [];
  for (const st of ed.stamps) {
    let pages = null;
    if (st.scope.mode === "pages") {
      pages = st.scope.uids.filter((u) => position.has(u)).map((u) => position.get(u));
      if (!pages.length) continue; // every page it was meant for is gone
    }
    out.push({ file_id: st.file, name: st.name, cx: st.cx, cy: st.cy, w: st.w, rot: st.rot, opacity: st.opacity, pages });
  }
  return out;
}

// Bookmark targets are stored as page identities so reordering follows them; the server
// needs the current 0-based position (-1 when the target page no longer exists).
function edBookmarksForExport() {
  const position = new Map(ed.pages.map((p, i) => [p.uid, i]));
  return ed.bookmarks.map((b) => ({
    level: b.level,
    title: b.title,
    page: b.target !== null && position.has(b.target) ? position.get(b.target) : -1,
  }));
}

const edHasOverlays = () => !!ed.numbering || ed.stamps.length > 0;

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
  document.getElementById("edit-numbering-btn").addEventListener("click", edOpenNumberingDialog);
  document.getElementById("edit-bookmark-btn").addEventListener("click", edOpenBookmarkDialog);
  document.getElementById("edit-stamp-btn").addEventListener("click", edOpenStampDialog);
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
