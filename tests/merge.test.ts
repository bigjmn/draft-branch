import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeDrafts,
  type MergeBlock,
  type MergeDraft,
} from "../src/lib/projects/merge";

const b = (id: string, text = id, type = "action"): MergeBlock => ({
  id,
  type,
  text,
});
const d = (blocks: MergeBlock[], title = "Pilot"): MergeDraft => ({
  title,
  blocks,
});
const ids = (draft: MergeDraft) => draft.blocks.map((x) => x.id);
const base = d([b("s1", "INT. KITCHEN", "scene"), b("a1"), b("a2"), b("a3")]);

test("non-overlapping edits merge cleanly from both sides", () => {
  const target = d([base.blocks[0], b("a1", "kettle boils"), b("a2"), b("a3")]);
  const source = d([...base.blocks, b("s2", "EXT. YARD", "scene")], "Pilot v2");
  const result = mergeDrafts(base, target, source);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.draft.title, "Pilot v2");
  assert.deepEqual(ids(result.draft), ["s1", "a1", "a2", "a3", "s2"]);
  assert.equal(result.draft.blocks[1].text, "kettle boils");
});

test("both sides editing one element is a content conflict with four resolutions", () => {
  const target = d([base.blocks[0], b("a1", "main words"), b("a2"), b("a3")]);
  const source = d([base.blocks[0], b("a1", "branch words"), b("a2"), b("a3")]);
  const open = mergeDrafts(base, target, source);
  assert.deepEqual(open.unresolved, ["block:a1"]);
  assert.equal(open.conflicts[0].kind, "content");
  assert.equal(open.draft.blocks[1].text, "main words"); // preview keeps target
  const pick = (r: Parameters<typeof mergeDrafts>[3]) =>
    mergeDrafts(base, target, source, r).draft.blocks.map((x) => x.text);
  assert.deepEqual(pick({ "block:a1": "source" }).slice(1, 2), [
    "branch words",
  ]);
  assert.deepEqual(pick({ "block:a1": "both" }).slice(1, 3), [
    "main words",
    "branch words",
  ]);
  assert.deepEqual(pick({ "block:a1": { text: "rewritten" } }).slice(1, 2), [
    "rewritten",
  ]);
  const both = mergeDrafts(base, target, source, { "block:a1": "both" });
  assert.equal(new Set(ids(both.draft)).size, both.draft.blocks.length);
  assert.deepEqual(both.unresolved, []);
});

test("delete versus edit is a conflict; a plain delete merges", () => {
  const target = d([base.blocks[0], b("a2"), b("a3")]); // deleted a1
  const source = d([base.blocks[0], b("a1", "edited"), b("a2")]); // edited a1, deleted a3
  const open = mergeDrafts(base, target, source);
  assert.deepEqual(open.unresolved, ["block:a1"]);
  assert.equal(open.conflicts[0].kind, "delete");
  assert.deepEqual(ids(open.draft), ["s1", "a2"]);
  const kept = mergeDrafts(base, target, source, { "block:a1": "source" });
  assert.deepEqual(ids(kept.draft), ["s1", "a1", "a2"]);
});

test("insertions at the same place conflict on order; resolution sets which comes first", () => {
  const target = d([base.blocks[0], b("t1"), ...base.blocks.slice(1)]);
  const source = d([base.blocks[0], b("x1"), ...base.blocks.slice(1)]);
  const open = mergeDrafts(base, target, source);
  assert.deepEqual(open.unresolved, ["order:s1"]);
  assert.deepEqual(ids(open.draft), ["s1", "t1", "x1", "a1", "a2", "a3"]);
  const sourceFirst = mergeDrafts(base, target, source, {
    "order:s1": "source",
  });
  assert.deepEqual(ids(sourceFirst.draft), [
    "s1",
    "x1",
    "t1",
    "a1",
    "a2",
    "a3",
  ]);
});

test("a move on one side and an edit on the other both apply", () => {
  const target = d([base.blocks[0], b("a2"), b("a3"), b("a1")]); // moved a1 to end
  const source = d([base.blocks[0], b("a1", "edited"), b("a2"), b("a3")]);
  const result = mergeDrafts(base, target, source);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(ids(result.draft), ["s1", "a2", "a3", "a1"]);
  assert.equal(result.draft.blocks[3].text, "edited");
});

test("moving the same element to different places is a move conflict", () => {
  const target = d([b("a1"), base.blocks[0], b("a2"), b("a3")]);
  const source = d([base.blocks[0], b("a2"), b("a3"), b("a1")]);
  const open = mergeDrafts(base, target, source);
  assert.deepEqual(open.unresolved, ["move:a1"]);
  assert.deepEqual(ids(open.draft), ["a1", "s1", "a2", "a3"]);
  const theirs = mergeDrafts(base, target, source, { "move:a1": "source" });
  assert.deepEqual(ids(theirs.draft), ["s1", "a2", "a3", "a1"]);
});

test("title conflicts accept custom text; invalid resolutions stay unresolved", () => {
  const target = d(base.blocks, "Main title");
  const source = d(base.blocks, "Branch title");
  assert.deepEqual(mergeDrafts(base, target, source).unresolved, ["title"]);
  assert.equal(
    mergeDrafts(base, target, source, { title: { text: "Agreed" } }).draft
      .title,
    "Agreed",
  );
  assert.deepEqual(
    mergeDrafts(base, target, source, { title: "both" }).unresolved,
    ["title"],
  );
});

test("identical changes on both sides and unrelated resolutions are harmless", () => {
  const same = d([
    ...base.blocks.slice(0, 2),
    b("n1"),
    ...base.blocks.slice(2),
  ]);
  const result = mergeDrafts(base, same, same, { "block:zzz": "source" });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(ids(result.draft), ids(same));
});

test("conflict ids do not depend on the chosen resolutions", () => {
  const target = d([b("t0"), b("a1", "T"), base.blocks[0], b("a3")]);
  const source = d([
    b("x0"),
    b("a3"),
    b("a1", "S"),
    base.blocks[0],
    b("a2", "S"),
  ]);
  const open = mergeDrafts(base, target, source).conflicts.map((c) => c.id);
  const all = Object.fromEntries(open.map((id) => [id, "source" as const]));
  const resolved = mergeDrafts(base, target, source, all);
  assert.deepEqual(
    resolved.conflicts.map((c) => c.id),
    open,
  );
  assert.deepEqual(resolved.unresolved, []);
  assert.equal(new Set(ids(resolved.draft)).size, resolved.draft.blocks.length);
});

test("merging everything away still leaves one element", () => {
  const empty = d([b("s1", "INT. KITCHEN", "scene")]);
  const result = mergeDrafts(empty, d([]), d([]));
  assert.equal(result.draft.blocks.length, 1);
});
