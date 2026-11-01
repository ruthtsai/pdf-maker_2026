// The Edit Session: the document a person is building, before anything is exported.
// It is an ordered list of Pages ({src file, page index, extra rotation}) plus what is
// attached to them; a new PDF is only built on the server when the user exports.
// No DOM and no server calls here, so everything can be tested under Node.

const HISTORY_LIMIT = 100;

function sourceEntry(item, pages) {
  return { id: item.id, name: item.name, page_count: item.page_count, status: item.status, pages };
}

// source: an uploaded file item; info: its document info ({pages, labels, toc}).
export function createEditSession(source, info) {
  const sources = { [source.id]: sourceEntry(source, info.pages) };
  let nextUid = 1;
  const newPage = (src, idx, rot = 0) => ({ uid: nextUid++, src, idx, rot });

  let pages = Array.from({ length: source.page_count }, (_, i) => newPage(source.id, i));
  let labels = (info.labels || []).map((l) => ({
    start: l.startpage || 0,
    style: l.style || "",
    prefix: l.prefix || "",
    first: l.firstpagenum || 1,
  }));
  let bookmarks = (info.toc || []).map((t, i) => ({
    id: i + 1,
    level: t.level,
    title: t.title,
    target: t.page >= 1 && t.page <= source.page_count ? pages[t.page - 1].uid : null,
  }));
  let stamps = [];
  let numbering = null;
  let selection = new Set();
  let anchor = null;

  const snapshot = () => JSON.stringify({ pages, labels, numbering, bookmarks, stamps });
  const history = [snapshot()];
  let hIndex = 0;

  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  // Call after every document mutation.
  function commit() {
    history.length = hIndex + 1;
    history.push(snapshot());
    if (history.length > HISTORY_LIMIT) history.shift();
    hIndex = history.length - 1;
    notify();
  }

  function goto(index) {
    if (index < 0 || index >= history.length) return;
    hIndex = index;
    ({ pages, labels, numbering, bookmarks, stamps } = JSON.parse(history[index]));
    const alive = new Set(pages.map((p) => p.uid));
    selection = new Set([...selection].filter((u) => alive.has(u)));
    notify();
  }

  function select(uids) {
    selection = new Set(uids);
    anchor = uids.length ? uids[0] : null;
  }

  const positionOf = (uid) => pages.findIndex((p) => p.uid === uid);

  return {
    get sources() {
      return sources;
    },
    get baseId() {
      return source.id;
    },
    get pages() {
      return pages;
    },
    get labels() {
      return labels;
    },
    get numbering() {
      return numbering;
    },
    get bookmarks() {
      return bookmarks;
    },
    get stamps() {
      return stamps;
    },
    get selection() {
      return selection;
    },
    get canUndo() {
      return hIndex > 0;
    },
    get canRedo() {
      return hIndex < history.length - 1;
    },
    // True once anything has been committed, even if it was undone again.
    get edited() {
      return history.length > 1;
    },

    // The listener runs after every document change, including undo and redo.
    // Selection commands don't notify: callers refresh the selection themselves.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    undo: () => goto(hIndex - 1),
    redo: () => goto(hIndex + 1),

    positionOf,

    selectedPositions() {
      return pages.map((p, i) => (selection.has(p.uid) ? i + 1 : 0)).filter(Boolean);
    },

    select,
    selectAll: () => select(pages.map((p) => p.uid)),

    // toggle: Ctrl/Cmd held; range: Shift held.
    clickPage(uid, { toggle = false, range = false } = {}) {
      if (range && anchor !== null && positionOf(anchor) >= 0) {
        const a = positionOf(anchor);
        const b = positionOf(uid);
        const [from, to] = a < b ? [a, b] : [b, a];
        const uids = pages.slice(from, to + 1).map((p) => p.uid);
        selection = toggle ? new Set([...selection, ...uids]) : new Set(uids);
      } else if (toggle) {
        if (selection.has(uid)) selection.delete(uid);
        else selection.add(uid);
        anchor = uid;
      } else {
        selection = new Set([uid]);
        anchor = uid;
      }
    },

    addSource(item, sourcePages) {
      sources[item.id] = sourceEntry(item, sourcePages);
      return sources[item.id];
    },

    forgetSource(id) {
      delete sources[id];
    },

    // Whether the document, or any state undo can reach, still uses this file.
    referencesFile(id) {
      return history.some((snap) => {
        const s = JSON.parse(snap);
        return s.pages.some((p) => p.src === id) || s.stamps.some((st) => st.file === id);
      });
    },

    // Moves the pages `uids` (kept in their current relative order) next to `targetUid`;
    // targetUid === null means "to the very end".
    moveBlock(uids, targetUid, after) {
      const set = new Set(uids);
      if (targetUid !== null && set.has(targetUid)) return;
      const moving = pages.filter((p) => set.has(p.uid));
      const rest = pages.filter((p) => !set.has(p.uid));
      const at = targetUid === null ? rest.length : rest.findIndex((p) => p.uid === targetUid) + (after ? 1 : 0);
      const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      if (next.every((p, i) => p.uid === pages[i].uid)) return;
      pages = next;
      commit();
    },

    // Applies to the selection, or to the whole document when nothing is selected.
    rotate(degrees) {
      const targets = selection.size ? pages.filter((p) => selection.has(p.uid)) : pages;
      targets.forEach((p) => {
        p.rot = (p.rot + degrees) % 360;
      });
      commit();
    },

    // Moves pages `nums` (1-based, current numbering) to just after page `after` (0 = front).
    movePages(nums, after) {
      const total = pages.length;
      if (!Number.isInteger(after) || after < 0 || after > total) throw new Error(`目標位置需介於 0 到 ${total}`);
      const moving = nums.map((n) => pages[n - 1]);
      const movingSet = new Set(moving.map((p) => p.uid));
      const target = after > 0 ? pages[after - 1] : null;
      if (target && movingSet.has(target.uid)) throw new Error(`第 ${after} 頁本身也在要移動的頁面中，請改選其他位置`);
      const rest = pages.filter((p) => !movingSet.has(p.uid));
      const at = target ? rest.findIndex((p) => p.uid === target.uid) + 1 : 0;
      pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      select(moving.map((p) => p.uid));
      commit();
    },

    insertPages(sourceId, nums, after) {
      const total = pages.length;
      if (!Number.isInteger(after) || after < 0 || after > total) throw new Error(`插入位置需介於 0 到 ${total}`);
      const fresh = nums.map((n) => newPage(sourceId, n - 1));
      pages = [...pages.slice(0, after), ...fresh, ...pages.slice(after)];
      select(fresh.map((p) => p.uid));
      commit();
    },

    // pairs: [{pos (1-based current position), srcIdx (0-based)}]
    replacePages(sourceId, pairs) {
      const fresh = [];
      pairs.forEach(({ pos, srcIdx }) => {
        const page = newPage(sourceId, srcIdx);
        const old = pages[pos - 1];
        bookmarks.forEach((b) => {
          if (b.target === old.uid) b.target = page.uid;
        });
        pages[pos - 1] = page;
        fresh.push(page.uid);
      });
      select(fresh);
      commit();
    },

    applyPageNumbers(nextLabels, nextNumbering) {
      labels = nextLabels;
      numbering = nextNumbering;
      commit();
    },

    applyBookmarks(next) {
      bookmarks = next;
      commit();
    },

    applyStamps(next) {
      stamps = next;
      commit();
    },
  };
}
