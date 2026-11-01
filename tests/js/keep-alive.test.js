import assert from "node:assert/strict";
import { test } from "node:test";

import { createKeepAlive } from "../../web/static/keep-alive.js";

const f = (id, name = `${id}.pdf`) => ({ id, name });

// A server that has lost the given ids; it records what it was sent.
function setup(lost = []) {
  const server = { sent: [], lost: new Set(lost) };
  server.send = async (ids) => {
    server.sent.push(ids);
    return ids.filter((id) => server.lost.has(id));
  };
  const reports = [];
  const keepAlive = createKeepAlive({ send: server.send, report: (lostFiles) => reports.push(lostFiles) });
  return { server, reports, keepAlive };
}

test("one heartbeat carries the files of every tab, each id once", async () => {
  const { server, keepAlive } = setup();
  keepAlive.register("合併", () => [f("a"), f("b")]);
  keepAlive.register("編輯頁面", () => [f("b"), f("c")]);
  await keepAlive.beat();
  assert.deepEqual(server.sent, [["a", "b", "c"]]);
});

test("nothing is sent while no tab has a file", async () => {
  const { server, keepAlive } = setup();
  keepAlive.register("壓縮", () => []);
  await keepAlive.beat();
  assert.deepEqual(server.sent, []);
});

test("lost files are reported with their tab and name", async () => {
  const { reports, keepAlive } = setup(["b"]);
  keepAlive.register("合併", () => [f("a"), f("b", "封面.pdf")]);
  keepAlive.register("編輯頁面", () => [f("b", "封面.pdf")]);
  keepAlive.register("壓縮", () => [f("c")]);
  await keepAlive.beat();
  assert.deepEqual(reports, [
    [
      { tab: "合併", name: "封面.pdf" },
      { tab: "編輯頁面", name: "封面.pdf" },
    ],
  ]);
});

test("a lost file is reported only once", async () => {
  const { server, reports, keepAlive } = setup(["a"]);
  keepAlive.register("合併", () => [f("a")]);
  await keepAlive.beat();
  await keepAlive.beat();
  assert.equal(reports.length, 1);
  server.lost.add("b");
  keepAlive.register("轉換", () => [f("b")]);
  await keepAlive.beat();
  assert.deepEqual(reports[1], [{ tab: "轉換", name: "b.pdf" }]);
});

test("nothing is reported when every file is still there", async () => {
  const { reports, keepAlive } = setup();
  keepAlive.register("合併", () => [f("a")]);
  await keepAlive.beat();
  assert.deepEqual(reports, []);
});

test("a failed heartbeat is ignored and the next one still works", async () => {
  const reports = [];
  let fail = true;
  const keepAlive = createKeepAlive({
    send: async (ids) => {
      if (fail) throw new Error("offline");
      return ids;
    },
    report: (lost) => reports.push(lost),
  });
  keepAlive.register("合併", () => [f("a")]);
  await keepAlive.beat();
  assert.deepEqual(reports, []);
  fail = false;
  await keepAlive.beat();
  assert.deepEqual(reports, [[{ tab: "合併", name: "a.pdf" }]]);
});

test("a tab's file list is read at each heartbeat", async () => {
  const { server, keepAlive } = setup();
  let files = [f("a")];
  keepAlive.register("轉換", () => files);
  await keepAlive.beat();
  files = [f("z")];
  await keepAlive.beat();
  assert.deepEqual(server.sent, [["a"], ["z"]]);
});
