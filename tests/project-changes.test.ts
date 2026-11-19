import { test } from "node:test";
import assert from "node:assert/strict";
import { draftChanges } from "../src/lib/projects/changes";
import type { Draft, ScriptBlock } from "../src/lib/editor/types";
const block = (id: string, text = id): ScriptBlock => ({
  id,
  text,
  type: "action",
});
const draft = (blocks: ScriptBlock[], title = "Title"): Draft => ({
  blocks,
  title,
});
test("inserting a scene does not mark existing blocks as moved", () => {
  const before = draft([block("a"), block("b")]);
  const after = draft([block("new"), ...before.blocks]);
  assert.deepEqual(
    draftChanges(before, after).map((c) => [c.id, c.kind]),
    [["new", "added"]],
  );
});
test("diff detects title, text, type, removal, and order changes", () => {
  const before = draft([block("a"), block("b"), block("c"), block("d")]);
  const after = draft(
    [block("c"), block("b", "new words"), { ...block("a"), type: "scene" }],
    "New title",
  );
  assert.deepEqual(
    draftChanges(before, after).map((c) => [c.id, c.kind]),
    [
      ["title", "modified"],
      ["c", "moved"],
      ["b", "modified"],
      ["a", "modified"],
      ["d", "removed"],
    ],
  );
  assert.deepEqual(draftChanges(before, before), []);
});
