import { createKeepAlive } from "./keep-alive.js";

// The one heartbeat shared by every tab (see keep-alive.js). Tabs register the files they
// still need; this module does the sending, the timing and the telling.

const HEARTBEAT_MS = 5 * 60 * 1000; // the server sweeps files idle for 30 minutes

function reportLost(lost) {
  const byTab = new Map();
  for (const { tab, name } of lost) byTab.set(tab, [...(byTab.get(tab) || []), name]);
  const parts = [...byTab].map(([tab, names]) => `「${tab}」${[...new Set(names)].join("、")}`);
  showError(`這些檔案已在伺服器上失效，無法再處理或匯出，請重新開啟：${parts.join("；")}`);
}

export const keepAlive = createKeepAlive({
  send: async (ids) => {
    const { missing } = await apiFetch(`${API}/files/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: ids }),
    });
    return missing;
  },
  report: reportLost,
});

// The tabs written in app.js (a classic script) list their files through appTabFiles().
for (const tab of Object.keys(appTabFiles())) keepAlive.register(tab, () => appTabFiles()[tab]);

setInterval(() => keepAlive.beat(), HEARTBEAT_MS);
// Timers barely run while the computer sleeps or the tab is hidden; catch up on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAlive.beat();
});
