// The Edit Session: the document a person is building, before anything is exported.
// It is an ordered list of Pages ({src file, page index, extra rotation}) plus what is
// attached to them; a new PDF is only built on the server when the user exports.
// No DOM and no server calls here, so everything can be tested under Node.

const HISTORY_LIMIT = 100;

export const DEFAULT_NUMBERING = { v_pos: "bottom", h_pos: "center", fmt: "number", start_page: 1, start_number: 1, font_size: 10, margin: 28 };

// ---------- bookmark outline ----------
// A flat list of {level, ...} read as a tree: an entry's children are the deeper
// entries right after it. These work on a dialog's Draft and return a new list.

const subtreeEnd = (items, i) => {
  let j = i + 1;
  while (j < items.length && items[j].level > items[i].level) j++;
  return j;
};

const copyItems = (items) => items.map((b) => ({ ...b }));

// Shifts a bookmark and its children, as far as its previous sibling allows.
export function shiftBookmarkLevel(items, i, delta) {
  const next = copyItems(items);
  const end = subtreeEnd(next, i);
  const maxLevel = i === 0 ? 1 : next[i - 1].level + 1;
  const applied = Math.max(1, Math.min(next[i].level + delta, maxLevel)) - next[i].level;
  for (let k = i; k < end; k++) next[k].level = Math.max(1, next[k].level + applied);
  return next;
}

// Removes one bookmark; its children move up a level.
export function removeBookmark(items, i) {
  const next = copyItems(items);
  const end = subtreeEnd(next, i);
  for (let k = i + 1; k < end; k++) next[k].level = Math.max(1, next[k].level - 1);
  next.splice(i, 1);
  return next;
}

// Moves bookmark `from` together with its children next to row `toRow`.
export function moveBookmarkSubtree(items, from, toRow, after) {
  const end = subtreeEnd(items, from);
  if (toRow >= from && toRow < end) return items; // dropped inside itself
  const block = items.slice(from, end);
  const rest = [...items.slice(0, from), ...items.slice(end)];
  const row = toRow < from ? toRow : toRow - block.length;
  const at = after ? subtreeEnd(rest, row) : row;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

// ---------- stamp scope ----------

export function stampScopeKind(stamp) {
  if (stamp.scope.mode === "all") return "all";
  return stamp.scope.custom ? "range" : "current";
}

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

  // Page-following references pass from a page to the one that takes its place.
  function transferReferences(fromUid, toUid) {
    bookmarks.forEach((b) => {
      if (b.target === fromUid) b.target = toUid;
    });
    stamps.forEach((st) => {
      if (st.scope.mode === "pages") st.scope.uids = st.scope.uids.map((u) => (u === fromUid ? toUid : u));
    });
  }

  // Stamps limited to chosen pages are stored by page identity; the server wants output positions.
  function stampsForRecipe() {
    const position = new Map(pages.map((p, i) => [p.uid, i]));
    const out = [];
    for (const st of stamps) {
      let onPages = null;
      if (st.scope.mode === "pages") {
        onPages = st.scope.uids.filter((u) => position.has(u)).map((u) => position.get(u));
        if (!onPages.length) continue; // every page it was meant for is gone
      }
      out.push({ file_id: st.file, name: st.name, cx: st.cx, cy: st.cy, w: st.w, rot: st.rot, opacity: st.opacity, pages: onPages });
    }
    return out;
  }

  // Bookmark targets are stored as page identities so reordering follows them; the server
  // needs the current 0-based position (-1 when the target page no longer exists).
  function bookmarksForRecipe() {
    const position = new Map(pages.map((p, i) => [p.uid, i]));
    return bookmarks.map((b) => ({
      level: b.level,
      title: b.title,
      page: b.target !== null && position.has(b.target) ? position.get(b.target) : -1,
    }));
  }

  // Every file the document, or any state undo can reach, still uses: page sources
  // and stamp images. These must stay on the server while the session is open.
  function referencedFiles() {
    const ids = new Set();
    for (const snap of history) {
      const s = JSON.parse(snap);
      s.pages.forEach((p) => ids.add(p.src));
      s.stamps.forEach((st) => ids.add(st.file));
    }
    return [...ids];
  }

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

    referencedFiles,
    referencesFile: (id) => referencedFiles().includes(id),

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

    // Deletes pages `nums` (1-based, current numbering). Page-following references keep
    // pointing at the deleted pages, so undo restores them; position references that
    // would fall past the new end are pulled back inside it.
    deletePages(nums) {
      const total = pages.length;
      const bad = nums.find((n) => !Number.isInteger(n) || n < 1 || n > total);
      if (bad !== undefined) throw new Error(`頁碼需介於 1 到 ${total}`);
      const doomed = new Set(nums.map((n) => pages[n - 1].uid));
      if (doomed.size >= total) throw new Error("至少要保留一頁");
      pages = pages.filter((p) => !doomed.has(p.uid));
      labels = labels.filter((r) => r.start < pages.length);
      if (numbering && numbering.start_page > pages.length) numbering = { ...numbering, start_page: pages.length };
      select([]);
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
        transferReferences(old.uid, page.uid);
        pages[pos - 1] = page;
        fresh.push(page.uid);
      });
      select(fresh);
      commit();
    },

    // Replaces the label rules and printed numbering (null turns numbering off) as one
    // undo step. Throws Error with a user-facing message if a value is not allowed.
    applyPageNumbers(nextLabels, nextNumbering) {
      const total = pages.length;
      for (const r of nextLabels) {
        if (!Number.isInteger(r.start) || r.start < 0 || r.start >= total) throw new Error(`標籤規則的起始頁需介於 1 到 ${total}`);
        if (!Number.isInteger(r.first) || r.first < 1) throw new Error("標籤規則的起始號碼需大於等於 1");
      }
      if (new Set(nextLabels.map((r) => r.start)).size !== nextLabels.length) throw new Error("不同規則不能從同一頁開始");
      if (nextNumbering) {
        const n = nextNumbering;
        if (!Number.isInteger(n.start_page) || n.start_page < 1 || n.start_page > total) throw new Error(`蓋印的起始頁需介於 1 到 ${total}`);
        if (!Number.isFinite(n.start_number) || n.start_number < 0) throw new Error("起始號碼不可為負數");
        if (!Number.isFinite(n.font_size) || n.font_size < 4 || n.font_size > 72) throw new Error("字型大小需介於 4–72");
      }
      labels = nextLabels.map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
      numbering = nextNumbering ? { ...nextNumbering } : null;
      commit();
    },

    // items: [{id, level, title, target (page uid | null)}]
    applyBookmarks(items) {
      const blank = items.findIndex((b) => !b.title.trim());
      if (blank >= 0) throw new Error(`第 ${blank + 1} 個書籤沒有標題`);
      bookmarks = items.map((b) => ({ ...b, title: b.title.trim() }));
      commit();
    },

    // items: [{id, file, name, cx, cy, w, rot, opacity, scope:{mode:"all"}|{mode:"pages",uids}}]
    applyStamps(items) {
      for (const st of items) {
        if (st.scope.mode === "pages" && !st.scope.uids.length) throw new Error(`「${st.name}」沒有指定任何頁面`);
      }
      stamps = items.map((st) => {
        const { custom, ...scope } = st.scope;
        return { ...st, scope };
      });
      commit();
    },

    // 1-based position of a bookmark's page, or null when it has none.
    bookmarkPosition(bookmark) {
      const i = bookmark.target === null ? -1 : positionOf(bookmark.target);
      return i >= 0 ? i + 1 : null;
    },

    // kind: "all", "current" or "range"; positions are 1-based.
    stampScope(kind, positions = []) {
      if (kind === "all") return { mode: "all" };
      const uids = positions.map((n) => pages[n - 1].uid);
      return kind === "range" ? { mode: "pages", custom: true, uids } : { mode: "pages", uids };
    },

    stampAppliesTo(stamp, pageIndex) {
      return stamp.scope.mode === "all" || stamp.scope.uids.includes(pages[pageIndex].uid);
    },

    // The 1-based positions of the pages a page-limited stamp is on.
    stampPositions(stamp) {
      return stamp.scope.uids
        .map((u) => positionOf(u) + 1)
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
    },

    get hasOverlays() {
      return !!numbering || stamps.length > 0;
    },

    recipe(outputName, overrides = {}) {
      return {
        pages: pages.map((p) => ({ src: p.src, idx: p.idx, rot: p.rot })),
        output_name: outputName,
        page_labels: labels,
        page_numbers: numbering,
        bookmarks: bookmarksForRecipe(),
        stamps: stampsForRecipe(),
        ...overrides,
      };
    },

    summary() {
      return {
        originalPages: source.page_count,
        outputPages: pages.length,
        foreignPages: pages.filter((p) => p.src !== source.id).length,
        rotatedPages: pages.filter((p) => p.rot).length,
        numbering: numbering && { fmt: numbering.fmt, startPage: numbering.start_page },
        stamps: stamps.length,
        lostStamps: stamps.length - stampsForRecipe().length,
        labelRules: labels.length,
        bookmarks: bookmarks.length,
        lostBookmarks: bookmarksForRecipe().filter((b) => b.page < 0).length,
      };
    },
  };
}
