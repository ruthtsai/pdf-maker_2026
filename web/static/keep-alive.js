// Keeps uploaded files alive on the server. The server sweeps files nobody has used for
// 30 minutes, but much of the work (picking options, reordering pages, filling fields)
// never reaches it, so every tab reports the files it still needs on a shared heartbeat.
// No DOM and no server calls here: `send` and `report` are given by the caller.

// send(ids) -> Promise of the ids the server no longer has.
// report([{tab, name}]) is told about files that were lost, each file only once.
export function createKeepAlive({ send, report }) {
  const tabs = [];
  const reported = new Set();

  return {
    // files() -> [{id, name}], read again at every heartbeat.
    register(tab, files) {
      tabs.push({ tab, files });
    },

    async beat() {
      const byTab = tabs.map(({ tab, files }) => ({ tab, files: files() || [] }));
      const ids = [...new Set(byTab.flatMap((t) => t.files.map((file) => file.id)))];
      if (!ids.length) return;
      let missing;
      try {
        missing = new Set(await send(ids));
      } catch {
        return; // the server may be restarting; try again next time
      }
      const lost = [];
      const newlyLost = new Set();
      for (const { tab, files } of byTab) {
        for (const file of files) {
          const key = `${tab}\u0000${file.id}`;
          if (!missing.has(file.id) || reported.has(key)) continue;
          newlyLost.add(key);
          lost.push({ tab, name: file.name });
        }
      }
      newlyLost.forEach((key) => reported.add(key));
      if (lost.length) report(lost);
    },
  };
}
