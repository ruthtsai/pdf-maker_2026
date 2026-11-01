import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_NUMBERING,
  createEditSession,
  moveBookmarkSubtree,
  removeBookmark,
  shiftBookmarkLevel,
  stampScopeKind,
} from "../../web/static/edit-session.js";

const item = (id, page_count = 5) => ({ id, name: `${id}.pdf`, page_count, status: "ok" });
const pagesInfo = (n) => Array.from({ length: n }, () => ({ w: 100, h: 200, rotation: 0 }));

function open(info = {}, count = 5) {
  return createEditSession(item("base", count), { pages: pagesInfo(count), ...info });
}

// Original page numbers (1-based) in their current order.
const order = (s) => s.pages.map((p) => p.idx + 1);
const uidsAt = (s, ...positions) => positions.map((n) => s.pages[n - 1].uid);

test("a new session lists every source page in order and has nothing to undo", () => {
  const s = open();
  assert.deepEqual(order(s), [1, 2, 3, 4, 5]);
  assert.equal(s.canUndo, false);
  assert.equal(s.canRedo, false);
  assert.equal(s.edited, false);
});

test("existing labels and outline are read from the document info", () => {
  const s = open({
    labels: [{ startpage: 2, style: "r", prefix: "A-", firstpagenum: 3 }],
    toc: [
      { level: 1, title: "Intro", page: 2 },
      { level: 2, title: "Outside", page: 99 },
    ],
  });
  assert.deepEqual(s.labels, [{ start: 2, style: "r", prefix: "A-", first: 3 }]);
  assert.equal(s.bookmarks[0].target, s.pages[1].uid);
  assert.equal(s.bookmarks[1].target, null);
});

test("moveBlock moves pages next to a target and keeps their relative order", () => {
  const s = open();
  s.moveBlock(uidsAt(s, 4, 2), s.pages[0].uid, false);
  assert.deepEqual(order(s), [2, 4, 1, 3, 5]);
  s.moveBlock(uidsAt(s, 1), null, false);
  assert.deepEqual(order(s), [4, 1, 3, 5, 2]);
});

test("a moveBlock that changes nothing adds no undo step", () => {
  const s = open();
  s.moveBlock(uidsAt(s, 1), s.pages[1].uid, false);
  s.moveBlock(uidsAt(s, 1, 2), s.pages[0].uid, false);
  assert.equal(s.canUndo, false);
});

test("rotate applies to the selection, or to every page without one", () => {
  const s = open({}, 2);
  s.select(uidsAt(s, 2));
  s.rotate(90);
  assert.deepEqual(s.pages.map((p) => p.rot), [0, 90]);
  s.select([]);
  s.rotate(270);
  assert.deepEqual(s.pages.map((p) => p.rot), [270, 0]);
});

test("movePages places pages after a number and selects them", () => {
  const s = open();
  s.movePages([5], 2);
  assert.deepEqual(order(s), [1, 2, 5, 3, 4]);
  assert.deepEqual(s.selectedPositions(), [3]);
  s.movePages([1, 2], 0);
  assert.deepEqual(order(s), [1, 2, 5, 3, 4]);
});

test("movePages rejects a bad target without changing anything", () => {
  const s = open();
  assert.throws(() => s.movePages([1], 9), /目標位置需介於 0 到 5/);
  assert.throws(() => s.movePages([1, 2], 2), /第 2 頁本身/);
  assert.deepEqual(order(s), [1, 2, 3, 4, 5]);
  assert.equal(s.canUndo, false);
});

test("insertPages adds source pages at a position and selects them", () => {
  const s = open({}, 2);
  s.addSource(item("other", 3), pagesInfo(3));
  s.insertPages("other", [2, 3], 1);
  assert.deepEqual(s.pages.map((p) => `${p.src}:${p.idx}`), ["base:0", "other:1", "other:2", "base:1"]);
  assert.deepEqual(s.selectedPositions(), [2, 3]);
  assert.throws(() => s.insertPages("other", [1], 99), /插入位置需介於 0 到 4/);
});

test("replacePages swaps pages in place, resets rotation and selects the new pages", () => {
  const s = open({}, 3);
  s.rotate(90);
  s.addSource(item("other", 2), pagesInfo(2));
  s.replacePages("other", [{ pos: 2, srcIdx: 1 }]);
  assert.deepEqual(s.pages.map((p) => `${p.src}:${p.idx}:${p.rot}`), ["base:0:90", "other:1:0", "base:2:90"]);
  assert.deepEqual(s.selectedPositions(), [2]);
});

test("a bookmark passes to the page that replaces its target", () => {
  const s = open({ toc: [{ level: 1, title: "Ch", page: 2 }] }, 3);
  s.addSource(item("other", 1), pagesInfo(1));
  s.replacePages("other", [{ pos: 2, srcIdx: 0 }]);
  assert.equal(s.bookmarks[0].target, s.pages[1].uid);
});

test("a bookmark follows its page when pages move", () => {
  const s = open({ toc: [{ level: 1, title: "Ch", page: 2 }] }, 3);
  const uid = s.pages[1].uid;
  s.movePages([2], 3);
  assert.equal(s.bookmarks[0].target, uid);
  assert.equal(s.positionOf(uid), 2);
});

test("label rules and printed numbering stay at their position when pages move", () => {
  const s = open({}, 4);
  s.applyPageNumbers([{ start: 2, style: "D", prefix: "", first: 1 }], { ...DEFAULT_NUMBERING, start_page: 3 });
  s.movePages([4], 0);
  assert.equal(s.labels[0].start, 2);
  assert.equal(s.numbering.start_page, 3);
});

test("undo and redo walk through every committed change", () => {
  const s = open({}, 3);
  s.movePages([3], 0);
  s.rotate(90);
  s.undo();
  assert.deepEqual(s.pages.map((p) => p.rot), [0, 0, 0]);
  assert.deepEqual(order(s), [3, 1, 2]);
  s.undo();
  assert.deepEqual(order(s), [1, 2, 3]);
  assert.equal(s.canUndo, false);
  assert.equal(s.edited, true);
  s.redo();
  s.redo();
  assert.deepEqual(s.pages.map((p) => p.rot), [90, 0, 0]); // movePages left page 3 selected
  assert.equal(s.canRedo, false);
});

test("a new change discards the redo branch", () => {
  const s = open({}, 3);
  s.rotate(90);
  s.undo();
  s.rotate(180);
  assert.equal(s.canRedo, false);
  assert.deepEqual(s.pages.map((p) => p.rot), [180, 180, 180]);
});

test("undo reaches back at most 99 steps", () => {
  const s = open({}, 1);
  for (let i = 0; i < 120; i++) s.rotate(90);
  let steps = 0;
  while (s.canUndo) {
    s.undo();
    steps++;
  }
  assert.equal(steps, 99);
});

test("undo keeps only the selected pages that still exist", () => {
  const s = open({}, 1);
  s.addSource(item("other", 2), pagesInfo(2));
  const kept = s.pages[0].uid;
  s.insertPages("other", [1, 2], 1);
  s.select([kept, ...uidsAt(s, 2, 3)]);
  s.undo();
  assert.deepEqual([...s.selection], [kept]);
});

test("selection is not part of undo history", () => {
  const s = open({}, 2);
  s.rotate(90);
  s.select(uidsAt(s, 2));
  s.undo();
  assert.deepEqual(s.selectedPositions(), [2]);
});

test("clicking selects one page, Ctrl toggles and Shift selects a range from the anchor", () => {
  const s = open();
  const [a, b, c, d] = uidsAt(s, 1, 2, 3, 4);
  s.clickPage(b);
  assert.deepEqual(s.selectedPositions(), [2]);
  s.clickPage(d, { toggle: true });
  assert.deepEqual(s.selectedPositions(), [2, 4]);
  s.clickPage(d, { toggle: true });
  assert.deepEqual(s.selectedPositions(), [2]);
  s.clickPage(b);
  s.clickPage(d, { range: true });
  assert.deepEqual(s.selectedPositions(), [2, 3, 4]);
  s.clickPage(a, { range: true });
  assert.deepEqual(s.selectedPositions(), [1, 2]);
  s.clickPage(c);
  s.clickPage(d, { range: true, toggle: true });
  assert.deepEqual(s.selectedPositions(), [3, 4]);
});

test("listeners hear document changes and undo, and can unsubscribe", () => {
  const s = open({}, 2);
  let calls = 0;
  const off = s.subscribe(() => calls++);
  s.rotate(90);
  s.undo();
  s.select(uidsAt(s, 1));
  assert.equal(calls, 2);
  off();
  s.redo();
  assert.equal(calls, 2);
});

test("a file stays referenced while undo can still reach it", () => {
  const s = open({}, 1);
  s.addSource(item("other", 1), pagesInfo(1));
  assert.equal(s.referencesFile("other"), false);
  s.insertPages("other", [1], 1);
  s.undo();
  assert.equal(s.referencesFile("other"), true);
});

test("a forgotten source is gone from the session", () => {
  const s = open({}, 1);
  s.addSource(item("other", 1), pagesInfo(1));
  s.forgetSource("other");
  assert.equal(s.sources.other, undefined);
});

test("two sessions share nothing", () => {
  const a = open({}, 1);
  const b = open({}, 1);
  a.rotate(90);
  assert.equal(b.pages[0].rot, 0);
  assert.equal(b.canUndo, false);
});

const stamp = (scope, extra = {}) => ({ id: 1, file: "img", name: "seal.png", cx: 0.5, cy: 0.5, w: 0.25, rot: 0, opacity: 1, scope, ...extra });

test("the recipe lists pages in order with their rotation", () => {
  const s = open({}, 2);
  s.movePages([2], 0);
  s.rotate(90);
  const r = s.recipe("out.pdf");
  assert.equal(r.output_name, "out.pdf");
  assert.deepEqual(r.pages, [
    { src: "base", idx: 1, rot: 90 },
    { src: "base", idx: 0, rot: 0 },
  ]);
});

test("overrides replace parts of the recipe", () => {
  const s = open({ labels: [{ startpage: 0, style: "D" }] }, 1);
  assert.deepEqual(s.recipe("x.pdf", { page_labels: [] }).page_labels, []);
});

test("the recipe gives bookmarks their current 0-based position", () => {
  const s = open({ toc: [{ level: 1, title: "Ch", page: 1 }, { level: 2, title: "None", page: 0 }] }, 3);
  s.movePages([1], 3);
  assert.deepEqual(s.recipe("x.pdf").bookmarks, [
    { level: 1, title: "Ch", page: 2 },
    { level: 2, title: "None", page: -1 },
  ]);
});

test("the recipe gives a page-limited stamp its pages' current positions", () => {
  const s = open({}, 3);
  s.applyStamps([stamp(s.stampScope("range", [1, 2]))]);
  s.movePages([1], 3);
  assert.deepEqual(s.recipe("x.pdf").stamps[0].pages, [2, 0]);
});

test("a stamp on all pages has no page list in the recipe", () => {
  const s = open({}, 2);
  s.applyStamps([stamp(s.stampScope("all"))]);
  const [st] = s.recipe("x.pdf").stamps;
  assert.equal(st.pages, null);
  assert.equal(st.file_id, "img");
});

test("the summary reports what the export will contain", () => {
  const s = open({ toc: [{ level: 1, title: "Ch", page: 1 }, { level: 1, title: "None", page: 0 }] }, 2);
  s.addSource(item("other", 1), pagesInfo(1));
  s.insertPages("other", [1], 2);
  s.select([]);
  s.rotate(90);
  s.applyPageNumbers([{ start: 0, style: "D", prefix: "", first: 1 }], DEFAULT_NUMBERING);
  s.applyStamps([stamp(s.stampScope("all"))]);
  assert.deepEqual(s.summary(), {
    originalPages: 2,
    outputPages: 3,
    foreignPages: 1,
    rotatedPages: 3,
    numbering: { fmt: "number", startPage: 1 },
    stamps: 1,
    labelRules: 1,
    bookmarks: 2,
    lostBookmarks: 1,
  });
});

test("hasOverlays is true once numbering or stamps exist", () => {
  const s = open({}, 1);
  assert.equal(s.hasOverlays, false);
  s.applyPageNumbers([], DEFAULT_NUMBERING);
  assert.equal(s.hasOverlays, true);
  s.undo();
  s.applyStamps([stamp(s.stampScope("all"))]);
  assert.equal(s.hasOverlays, true);
});

const rule = (start, first = 1) => ({ start, style: "D", prefix: "", first });

test("page numbers are applied as one undo step with rules sorted by start", () => {
  const s = open();
  s.applyPageNumbers([rule(3), rule(0)], DEFAULT_NUMBERING);
  assert.deepEqual(s.labels.map((r) => r.start), [0, 3]);
  s.undo();
  assert.deepEqual(s.labels, []);
  assert.equal(s.numbering, null);
});

test("invalid page numbers are refused and change nothing", () => {
  const s = open({}, 3);
  const cases = [
    [[rule(3)], null, /標籤規則的起始頁需介於 1 到 3/],
    [[rule(0, 0)], null, /起始號碼需大於等於 1/],
    [[rule(1), rule(1)], null, /不同規則不能從同一頁開始/],
    [[], { ...DEFAULT_NUMBERING, start_page: 4 }, /蓋印的起始頁需介於 1 到 3/],
    [[], { ...DEFAULT_NUMBERING, start_number: -1 }, /起始號碼不可為負數/],
    [[], { ...DEFAULT_NUMBERING, font_size: 3 }, /字型大小需介於 4–72/],
  ];
  for (const [labels, numbering, message] of cases) assert.throws(() => s.applyPageNumbers(labels, numbering), message);
  assert.equal(s.canUndo, false);
});

test("applied page numbers are independent of the dialog's Draft", () => {
  const s = open();
  const draft = [rule(0)];
  s.applyPageNumbers(draft, null);
  draft[0].start = 4;
  assert.equal(s.labels[0].start, 0);
});

test("bookmark titles are trimmed and blank ones refused", () => {
  const s = open();
  s.applyBookmarks([{ id: 1, level: 1, title: "  Ch  ", target: null }]);
  assert.equal(s.bookmarks[0].title, "Ch");
  assert.throws(() => s.applyBookmarks([{ id: 1, level: 1, title: "ok", target: null }, { id: 2, level: 1, title: " ", target: null }]), /第 2 個書籤沒有標題/);
  assert.equal(s.bookmarks.length, 1);
});

test("bookmarkPosition gives the current 1-based position, or null", () => {
  const s = open({ toc: [{ level: 1, title: "Ch", page: 2 }] }, 2);
  s.movePages([2], 0);
  assert.equal(s.bookmarkPosition(s.bookmarks[0]), 1);
  assert.equal(s.bookmarkPosition({ target: null }), null);
  assert.equal(s.bookmarkPosition({ target: 999 }), null);
});

const outline = (...levels) => levels.map((level, i) => ({ id: i + 1, level, title: `b${i + 1}`, target: null }));
const shape = (items) => items.map((b) => `${b.id}:${b.level}`);

test("shifting a bookmark carries its children and stops at its previous sibling", () => {
  assert.deepEqual(shape(shiftBookmarkLevel(outline(1, 1, 2), 1, 1)), ["1:1", "2:2", "3:3"]);
  assert.deepEqual(shape(shiftBookmarkLevel(outline(1, 2), 1, 1)), ["1:1", "2:2"]);
  assert.deepEqual(shape(shiftBookmarkLevel(outline(1, 2), 0, 1)), ["1:1", "2:2"]);
  assert.deepEqual(shape(shiftBookmarkLevel(outline(1, 2, 3), 1, -1)), ["1:1", "2:1", "3:2"]);
});

test("removing a bookmark promotes its children", () => {
  assert.deepEqual(shape(removeBookmark(outline(1, 2, 3, 1), 1)), ["1:1", "3:2", "4:1"]);
});

test("moving a bookmark brings its children and skips the target's children when after", () => {
  const items = outline(1, 2, 1, 2, 1);
  assert.deepEqual(shape(moveBookmarkSubtree(items, 0, 4, false)), ["3:1", "4:2", "1:1", "2:2", "5:1"]);
  assert.deepEqual(shape(moveBookmarkSubtree(items, 0, 2, true)), ["3:1", "4:2", "1:1", "2:2", "5:1"]);
  assert.deepEqual(shape(moveBookmarkSubtree(items, 4, 0, false)), ["5:1", "1:1", "2:2", "3:1", "4:2"]);
});

test("a bookmark dropped inside itself stays put", () => {
  const items = outline(1, 2);
  assert.equal(moveBookmarkSubtree(items, 0, 1, true), items);
});

test("the outline helpers leave the Draft they were given untouched", () => {
  const items = outline(1, 1);
  shiftBookmarkLevel(items, 1, 1);
  removeBookmark(items, 0);
  assert.deepEqual(shape(items), ["1:1", "2:1"]);
});

test("a stamp scope records page identity, so it follows pages that move", () => {
  const s = open({}, 3);
  const current = stamp(s.stampScope("current", [1]));
  s.movePages([1], 3);
  assert.equal(stampScopeKind(current), "current");
  assert.equal(s.stampAppliesTo(current, 2), true);
  assert.equal(s.stampAppliesTo(current, 0), false);
  assert.deepEqual(s.stampPositions(current), [3]);
});

test("scope kinds tell all, current and range apart", () => {
  const s = open({}, 2);
  assert.equal(stampScopeKind(stamp(s.stampScope("all"))), "all");
  assert.equal(stampScopeKind(stamp(s.stampScope("current", [1]))), "current");
  assert.equal(stampScopeKind(stamp(s.stampScope("range", [1, 2]))), "range");
  assert.equal(s.stampAppliesTo(stamp(s.stampScope("all")), 1), true);
});

test("a page-limited stamp with no pages is refused, and the Draft marker is not stored", () => {
  const s = open({}, 2);
  assert.throws(() => s.applyStamps([stamp({ mode: "pages", uids: [] })]), /「seal.png」沒有指定任何頁面/);
  s.applyStamps([stamp(s.stampScope("range", [2]))]);
  assert.deepEqual(s.stamps[0].scope, { mode: "pages", uids: [s.pages[1].uid] });
});

test("a stamp image stays referenced while undo can reach it", () => {
  const s = open({}, 1);
  s.applyStamps([stamp(s.stampScope("all"))]);
  s.undo();
  assert.equal(s.referencesFile("img"), true);
  assert.equal(s.referencesFile("unused"), false);
});
