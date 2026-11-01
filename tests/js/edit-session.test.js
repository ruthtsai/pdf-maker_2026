import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditSession } from "../../web/static/edit-session.js";

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
  const labels = [{ start: 2, style: "D", prefix: "", first: 1 }];
  const numbering = { start_page: 3, fmt: "number" };
  s.applyPageNumbers(labels, numbering);
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
