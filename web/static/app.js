const API = "/api";
const ALLOWED_EXT = [".pdf", ".jpg", ".jpeg", ".png"];
const PAGE_RANGE_RE = /^(\d+(-\d+)?)(,\s*\d+(-\d+)?)*$/;

let mergeFiles = [];
let convertFile = null;

// ---------- generic helpers ----------

function showError(message) {
  const toast = document.getElementById("error-toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => toast.classList.add("hidden"), 5000);
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function isAllowedFile(file) {
  const name = file.name.toLowerCase();
  return ALLOWED_EXT.some((ext) => name.endsWith(ext));
}

function mkIconBtn(label, title, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn-icon";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function hideResult(id) {
  const area = document.getElementById(id);
  area.classList.add("hidden");
  area.classList.remove("is-error");
  area.innerHTML = "";
}

// ---------- File System Access API (optional "save as" flow) ----------
// Chromium-only; everything falls back to the plain <a download> link below
// when unsupported, so this is pure progressive enhancement.

function saveAsSupported() {
  return "showSaveFilePicker" in window && "showDirectoryPicker" in window;
}

async function fetchBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗（${res.status}）`);
  return res.blob();
}

async function writeBlobToHandle(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveResultToTarget(job, target) {
  if (target.type === "file") {
    const blob = await fetchBlob(job.download_url);
    await writeBlobToHandle(target.handle, blob);
    return `已儲存為「${target.handle.name}」`;
  }
  for (const f of job.files) {
    const blob = await fetchBlob(f.url);
    const fileHandle = await target.handle.getFileHandle(f.name, { create: true });
    await writeBlobToHandle(fileHandle, blob);
  }
  return `已儲存 ${job.files.length} 個檔案到「${target.handle.name}」資料夾`;
}

// ---------- tabs ----------

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------- dropzone ----------

function setupDropzone(zoneEl, inputEl, addBtn, onFiles) {
  addBtn.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", () => {
    onFiles(Array.from(inputEl.files));
    inputEl.value = "";
  });
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    zoneEl.classList.add("dragover");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("dragover"));
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.classList.remove("dragover");
    onFiles(Array.from(e.dataTransfer.files));
  });
}

// ---------- job polling (shared by merge + convert) ----------

function showProgress(prefix, job) {
  const area = document.getElementById(`${prefix}-progress`);
  area.classList.remove("hidden");
  const pct = job.total ? Math.round((job.current / job.total) * 100) : 0;
  area.querySelector(".progress-bar-fill").style.width = `${pct}%`;
  area.querySelector(".progress-label").textContent = job.total
    ? `處理中 ${job.current}/${job.total}：${job.message || ""}`
    : "處理中…";
}

function hideProgress(prefix) {
  document.getElementById(`${prefix}-progress`).classList.add("hidden");
}

function showResult(prefix, job, savedMessage) {
  const area = document.getElementById(`${prefix}-result`);
  area.classList.remove("hidden", "is-error");
  area.innerHTML = "";

  if (job.warning) {
    const warn = document.createElement("div");
    warn.textContent = job.warning;
    warn.style.marginBottom = "8px";
    area.appendChild(warn);
  }

  if (savedMessage) {
    const saved = document.createElement("div");
    saved.textContent = savedMessage;
    saved.style.marginBottom = "6px";
    saved.style.fontWeight = "600";
    area.appendChild(saved);
  }

  const label = document.createElement("div");
  label.textContent = savedMessage ? "或透過瀏覽器下載：" : "處理完成：";
  label.style.marginBottom = "6px";
  area.appendChild(label);

  if (job.download_url) {
    const a = document.createElement("a");
    a.href = job.download_url;
    a.textContent = "下載檔案";
    area.appendChild(a);
  } else if (job.files) {
    job.files.forEach((f) => {
      const a = document.createElement("a");
      a.href = f.url;
      a.textContent = f.name;
      area.appendChild(a);
    });
  }
}

function showResultError(prefix, message) {
  const area = document.getElementById(`${prefix}-result`);
  area.classList.remove("hidden");
  area.classList.add("is-error");
  area.textContent = `處理失敗：${message}`;
}

function watchJob(jobId, prefix, saveTarget) {
  const cancelBtn = document.querySelector(`#${prefix}-progress .btn-cancel`);
  cancelBtn.onclick = () =>
    apiFetch(`${API}/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});

  return new Promise((resolve) => {
    const poll = async () => {
      let job;
      try {
        job = await apiFetch(`${API}/jobs/${jobId}`);
      } catch (err) {
        hideProgress(prefix);
        showError(`查詢工作狀態失敗：${err.message}`);
        resolve();
        return;
      }
      if (job.status === "pending" || job.status === "running") {
        showProgress(prefix, job);
        setTimeout(poll, 400);
        return;
      }
      hideProgress(prefix);
      if (job.status === "done") {
        if (saveTarget) {
          try {
            const savedMessage = await saveResultToTarget(job, saveTarget);
            showResult(prefix, job, savedMessage);
          } catch (err) {
            showResult(prefix, job);
            showError(`寫入檔案失敗，請改用下方連結手動下載：${err.message}`);
          }
        } else {
          showResult(prefix, job);
        }
      } else if (job.status === "cancelled") {
        showError("已取消處理");
      } else {
        showResultError(prefix, job.error || "處理失敗");
      }
      resolve();
    };
    poll();
  });
}

// ---------- merge tab ----------

async function handleMergeFiles(fileList) {
  for (const file of fileList) {
    if (!isAllowedFile(file)) {
      showError(`不支援的檔案格式：${file.name}`);
      continue;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const item = await apiFetch(`${API}/upload`, { method: "POST", body: form });
      mergeFiles.push(item);
      renderMergeList();
    } catch (err) {
      showError(`上傳失敗：${file.name}（${err.message}）`);
    }
  }
}

function fileSubLabel(item) {
  return item.type === "pdf" ? `PDF · ${item.page_count} 頁` : "影像";
}

function buildMergeRow(item) {
  const li = document.createElement("li");
  li.className = "file-row";
  if (item.status === "error") li.classList.add("error");
  if (item.status === "encrypted") li.classList.add("encrypted");
  li.draggable = true;
  li.dataset.id = item.id;

  let thumb;
  if (item.thumbnail) {
    thumb = document.createElement("img");
    thumb.className = "file-thumb";
    thumb.src = item.thumbnail;
  } else {
    thumb = document.createElement("div");
    thumb.className = "file-thumb placeholder";
    thumb.textContent = item.type === "pdf" ? "PDF" : "IMG";
  }

  const meta = document.createElement("div");
  meta.className = "file-meta";
  const nameEl = document.createElement("div");
  nameEl.className = "file-name";
  nameEl.textContent = item.name;
  nameEl.title = item.name;
  const subEl = document.createElement("div");
  subEl.className = "file-sub";
  subEl.textContent = fileSubLabel(item);
  meta.appendChild(nameEl);
  meta.appendChild(subEl);

  if (item.status === "error") {
    const err = document.createElement("div");
    err.className = "file-error-msg";
    err.textContent = item.error_message || "檔案錯誤";
    meta.appendChild(err);
  }

  if (item.status === "encrypted") {
    const warn = document.createElement("div");
    warn.className = "file-error-msg";
    warn.textContent = item.error_message || "PDF 有密碼保護";
    meta.appendChild(warn);
    meta.appendChild(buildUnlockRow(item.id, (updated) => {
      const idx = mergeFiles.findIndex((f) => f.id === item.id);
      if (idx >= 0) mergeFiles[idx] = updated;
      renderMergeList();
    }));
  }

  const actions = document.createElement("div");
  actions.className = "file-actions";
  const index = mergeFiles.findIndex((f) => f.id === item.id);
  const upBtn = mkIconBtn("↑", "上移", () => moveMergeFile(item.id, -1));
  const downBtn = mkIconBtn("↓", "下移", () => moveMergeFile(item.id, 1));
  const delBtn = mkIconBtn("✕", "刪除", () => removeMergeFile(item.id));
  if (index === 0) upBtn.disabled = true;
  if (index === mergeFiles.length - 1) downBtn.disabled = true;
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);
  actions.appendChild(delBtn);

  li.appendChild(thumb);
  li.appendChild(meta);
  li.appendChild(actions);

  li.addEventListener("dragstart", () => li.classList.add("dragging"));
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    syncMergeOrderFromDom();
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    const ul = document.getElementById("merge-file-list");
    const dragging = ul.querySelector(".dragging");
    if (!dragging || dragging === li) return;
    const rect = li.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    ul.insertBefore(dragging, before ? li : li.nextSibling);
  });

  return li;
}

function buildUnlockRow(fileId, onUnlocked) {
  const row = document.createElement("div");
  row.className = "file-unlock";
  const pwInput = document.createElement("input");
  pwInput.type = "password";
  pwInput.placeholder = "輸入密碼";
  const unlockBtn = document.createElement("button");
  unlockBtn.className = "btn";
  unlockBtn.textContent = "解鎖";
  unlockBtn.addEventListener("click", async () => {
    if (!pwInput.value) {
      showError("請輸入密碼");
      return;
    }
    try {
      const updated = await apiFetch(`${API}/files/${fileId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput.value }),
      });
      onUnlocked(updated);
    } catch (err) {
      showError(`密碼錯誤：${err.message}`);
    }
  });
  row.appendChild(pwInput);
  row.appendChild(unlockBtn);
  return row;
}

function renderMergeList() {
  const ul = document.getElementById("merge-file-list");
  ul.innerHTML = "";
  mergeFiles.forEach((item) => ul.appendChild(buildMergeRow(item)));
  document.getElementById("merge-start-btn").disabled = mergeFiles.length === 0;
}

function syncMergeOrderFromDom() {
  const ul = document.getElementById("merge-file-list");
  const idOrder = Array.from(ul.children).map((li) => li.dataset.id);
  const byId = new Map(mergeFiles.map((f) => [f.id, f]));
  mergeFiles = idOrder.map((id) => byId.get(id)).filter(Boolean);
  renderMergeList();
}

function moveMergeFile(id, direction) {
  const idx = mergeFiles.findIndex((f) => f.id === id);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= mergeFiles.length) return;
  [mergeFiles[idx], mergeFiles[newIdx]] = [mergeFiles[newIdx], mergeFiles[idx]];
  renderMergeList();
}

async function removeMergeFile(id) {
  mergeFiles = mergeFiles.filter((f) => f.id !== id);
  renderMergeList();
  try {
    await apiFetch(`${API}/files/${id}`, { method: "DELETE" });
  } catch {
    /* best effort */
  }
}

async function startMerge() {
  const btn = document.getElementById("merge-start-btn");
  const outputName = document.getElementById("merge-output-name").value || "merged.pdf";
  const fileName = outputName.toLowerCase().endsWith(".pdf") ? outputName : `${outputName}.pdf`;

  let saveTarget = null;
  if (document.getElementById("merge-save-as").checked && saveAsSupported()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
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
  hideResult("merge-result");

  const payload = {
    file_ids: mergeFiles.map((f) => f.id),
    output_name: outputName,
    page_size: document.getElementById("opt-page-size").value,
    image_fit: document.getElementById("opt-image-fit").value,
  };

  try {
    const { job_id } = await apiFetch(`${API}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await watchJob(job_id, "merge", saveTarget);
  } catch (err) {
    showError(`合併失敗：${err.message}`);
  } finally {
    btn.disabled = mergeFiles.length === 0;
  }
}

// ---------- convert tab ----------

async function handleConvertFile(fileList) {
  const file = fileList[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("請選擇 PDF 檔案");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  try {
    const item = await apiFetch(`${API}/upload`, { method: "POST", body: form });
    convertFile = item;
    renderConvertInfo();
  } catch (err) {
    showError(`上傳失敗：${err.message}`);
  }
}

function renderConvertInfo() {
  const info = document.getElementById("convert-info");
  info.classList.remove("hidden");
  info.innerHTML = "";

  const nameEl = document.createElement("div");
  nameEl.textContent = `檔名：${convertFile.name}`;
  info.appendChild(nameEl);

  if (convertFile.status === "encrypted") {
    const warn = document.createElement("div");
    warn.className = "file-error-msg";
    warn.textContent = convertFile.error_message || "PDF 有密碼保護";
    info.appendChild(warn);
    info.appendChild(
      buildUnlockRow(convertFile.id, (updated) => {
        convertFile = updated;
        renderConvertInfo();
      })
    );
  } else if (convertFile.status === "error") {
    const err = document.createElement("div");
    err.className = "file-error-msg";
    err.textContent = convertFile.error_message || "檔案錯誤";
    info.appendChild(err);
  } else {
    const pages = document.createElement("div");
    pages.textContent = `總頁數：${convertFile.page_count}`;
    info.appendChild(pages);
  }

  document.getElementById("convert-start-btn").disabled = convertFile.status !== "ok";
}

function validatePageRangeInput(e) {
  const val = e.target.value.trim();
  const ok = val === "" || PAGE_RANGE_RE.test(val);
  e.target.style.borderColor = ok ? "" : "var(--danger)";
  e.target.title = ok ? "" : "格式範例：1-5,8,10-12";
}

async function startConvert() {
  if (!convertFile) return;
  const btn = document.getElementById("convert-start-btn");

  const dpi = Number(document.getElementById("opt-dpi").value);
  if (!Number.isFinite(dpi) || dpi < 72 || dpi > 600) {
    showError("解析度需介於 72–600 DPI");
    return;
  }
  const rangeVal = document.getElementById("opt-page-range").value.trim();
  if (rangeVal !== "" && !PAGE_RANGE_RE.test(rangeVal)) {
    showError("頁碼範圍格式錯誤，範例：1-5,8,10-12");
    return;
  }

  const packZip = document.getElementById("opt-output-mode").value === "zip";

  let saveTarget = null;
  if (document.getElementById("convert-save-as").checked && saveAsSupported()) {
    try {
      if (packZip) {
        const baseName = convertFile.name.replace(/\.pdf$/i, "");
        const handle = await window.showSaveFilePicker({
          suggestedName: `${baseName}.zip`,
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
        });
        saveTarget = { type: "file", handle };
      } else {
        const handle = await window.showDirectoryPicker();
        saveTarget = { type: "dir", handle };
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      showError(`無法選擇儲存位置：${err.message}`);
      return;
    }
  }

  btn.disabled = true;
  hideResult("convert-result");

  const payload = {
    file_id: convertFile.id,
    page_range: rangeVal,
    format: document.getElementById("opt-format").value,
    dpi,
    jpg_quality: Number(document.getElementById("opt-jpg-quality").value),
    pack_zip: packZip,
    output_name: "",
  };

  try {
    const { job_id } = await apiFetch(`${API}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await watchJob(job_id, "convert", saveTarget);
  } catch (err) {
    showError(`轉換失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();

  if (saveAsSupported()) {
    document.getElementById("merge-save-as-row").classList.remove("hidden");
    document.getElementById("convert-save-as-row").classList.remove("hidden");
  }

  setupDropzone(
    document.getElementById("merge-dropzone"),
    document.getElementById("merge-file-input"),
    document.getElementById("merge-add-btn"),
    handleMergeFiles
  );
  setupDropzone(
    document.getElementById("convert-dropzone"),
    document.getElementById("convert-file-input"),
    document.getElementById("convert-add-btn"),
    handleConvertFile
  );

  document.getElementById("merge-start-btn").addEventListener("click", startMerge);
  document.getElementById("convert-start-btn").addEventListener("click", startConvert);

  document.getElementById("opt-format").addEventListener("change", (e) => {
    document.getElementById("opt-jpg-quality-label").classList.toggle("hidden", e.target.value !== "jpg");
  });
  document.getElementById("opt-page-range").addEventListener("input", validatePageRangeInput);
});
