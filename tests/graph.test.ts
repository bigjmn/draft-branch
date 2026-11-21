import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aheadBehind,
  layoutGraph,
  orderCommits,
  type GraphCommit,
} from "../src/lib/projects/graph";

const c = (oid: string, parent: string[], timestamp: number): GraphCommit => ({
  oid,
  parent,
  timestamp,
});
// init ── m1 ─────────── merge   ← main
//           └── b1 ── b2 ┘        ← branch
const commits = [
  c("init", [], 1),
  c("m1", ["init"], 2),
  c("b1", ["m1"], 3),
  c("b2", ["b1"], 5),
  c("m2", ["m1"], 4),
  c("merge", ["m2", "b2"], 6),
];

test("ordering never lists a parent before its children", () => {
  const order = orderCommits([...commits].reverse()).map((x) => x.oid);
  assert.deepEqual(order, ["merge", "b2", "m2", "b1", "m1", "init"]);
  // Clock skew: a child older than its parent still comes first.
  const skewed = orderCommits([c("p", [], 10), c("child", ["p"], 1)]);
  assert.deepEqual(
    skewed.map((x) => x.oid),
    ["child", "p"],
  );
});

test("merge commits open a second lane that rejoins at the fork", () => {
  const rows = layoutGraph(orderCommits(commits));
  const byId = Object.fromEntries(rows.map((r) => [r.oid, r]));
  assert.equal(byId.merge.merge, true);
  assert.equal(byId.merge.lane, 0);
  assert.equal(byId.b2.lane, 1);
  assert.equal(byId.m2.lane, 0);
  assert.equal(byId.b1.lane, 1);
  // b1's line bends into m1's lane; m1 receives both lanes.
  assert.ok(
    byId.b1.segments.some(
      (s) => s.kind === "out" && s.from === 1 && s.to === 0,
    ),
  );
  assert.equal(
    byId.m1.segments.filter((s) => s.kind === "in").length,
    1, // lane 1 already merged into lane 0 above
  );
  // The first row is a tip: nothing enters it from above.
  assert.equal(rows[0].segments.filter((s) => s.kind === "in").length, 0);
  assert.equal(byId.init.segments.filter((s) => s.kind === "out").length, 0);
});

test("ahead/behind counts follow ancestry, not time", () => {
  const byId = new Map(commits.map((x) => [x.oid, x]));
  assert.deepEqual(aheadBehind(byId, "b2", "m2"), { ahead: 2, behind: 1 });
  assert.deepEqual(aheadBehind(byId, "merge", "b2"), { ahead: 2, behind: 0 });
});
