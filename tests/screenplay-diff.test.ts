import { test } from "node:test";
import assert from "node:assert/strict";
import { screenplayDiff, foldDiff } from "../src/lib/projects/screenplay-diff";
import type { Draft, ScriptBlock } from "../src/lib/editor/types";
const block = (id: string, text = id): ScriptBlock => ({
  id,
  text,
  type: "action",
});
const draft = (blocks: ScriptBlock[], title = "Pilot"): Draft => ({
  title,
  blocks,
});
function reconstruct(before: Draft, after: Draft) {
  const rows = screenplayDiff(before, after).filter((r) => !r.title);
  assert.deepEqual(
    rows.filter((r) => r.kind !== "added").map((r) => r.block),
    before.blocks,
  );
  assert.deepEqual(
    rows.filter((r) => r.kind !== "removed").map((r) => r.block),
    after.blocks,
  );
}
test("unified diff reconstructs both sides through deletions, inserts, modifications and moves", () => {
  const before = draft([
    block("a"),
    block("b"),
    block("c"),
    block("d"),
    block("e"),
  ]);
  const after = draft([
    block("d"),
    block("a"),
    block("c", "Changed"),
    block("new"),
    { ...block("e"), type: "dialogue" },
  ]);
  reconstruct(before, after);
  const rows = screenplayDiff(before, after);
  assert.equal(rows.filter((r) => r.block.id === "c").length, 2);
  assert.equal(rows.filter((r) => r.block.id === "e").length, 2);
});
test("unchanged elements retain old/new numbers and only inserted elements are added", () => {
  const rows = screenplayDiff(
    draft([block("a"), block("b")]),
    draft([block("x"), block("a"), block("b")]),
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.oldNumber, r.newNumber]),
    [
      ["added", undefined, 1],
      ["context", 1, 2],
      ["context", 2, 3],
    ],
  );
});
test("folds leading, internal and trailing context without dropping any rows", () => {
  const before = draft(Array.from({ length: 40 }, (_, i) => block(String(i))));
  const after = draft(
    before.blocks.map((b, i) =>
      i === 10 || i === 28 ? { ...b, text: "Changed" } : b,
    ),
  );
  const rows = screenplayDiff(before, after),
    sections = foldDiff(rows);
  assert.equal(sections.filter((s) => s.kind === "fold").length, 3);
  assert.deepEqual(
    sections.flatMap((s) => s.rows),
    rows,
  );
  assert.ok(
    sections
      .filter((s) => s.kind === "fold")
      .every((s) => s.rows.every((r) => r.kind === "context")),
  );
});
test("empty drafts, title changes, and repeated text with distinct IDs stay unambiguous", () => {
  reconstruct(draft([]), draft([block("a")]));
  reconstruct(draft([block("a")]), draft([]));
  reconstruct(
    draft([block("a", "Same"), block("b", "Same")]),
    draft([block("b", "Same"), block("a", "Same")]),
  );
  const rows = screenplayDiff(draft([], "Old"), draft([], "New"));
  assert.deepEqual(
    rows.map((r) => [r.kind, r.title, r.block.text]),
    [
      ["removed", true, "Old"],
      ["added", true, "New"],
    ],
  );
});
test("large mostly unchanged screenplays do not use a quadratic alignment matrix", () => {
  const before = draft(
    Array.from({ length: 15000 }, (_, i) => block(String(i))),
  );
  const after = draft([block("new"), ...before.blocks]);
  reconstruct(before, after);
  assert.equal(
    foldDiff(screenplayDiff(before, after)).filter((s) => s.kind === "fold")
      .length,
    1,
  );
});

test("fold boundaries retain a character cue with visible dialogue", () => {
  const blocks = Array.from({ length: 10 }, (_, i) => block(String(i)));
  blocks.push(
    { ...block("speaker", "O’HARA"), type: "character" },
    { ...block("speech", "Wait."), type: "dialogue" },
    block("pause"),
    block("look"),
    block("change"),
  );
  const before = draft(blocks),
    after = draft(
      blocks.map((b) => (b.id === "change" ? { ...b, text: "Changed" } : b)),
    );
  const sections = foldDiff(screenplayDiff(before, after));
  assert.ok(
    sections
      .filter((s) => s.kind === "rows")
      .flatMap((s) => s.rows)
      .some((r) => r.block.id === "speaker"),
  );
});

test("uppercase presentation does not flag unchanged imported cues and headings", async () => {
  const { draftChanges } = await import("../src/lib/projects/changes");
  for (const type of ["scene", "character", "shot", "transition"] as const) {
    const before = draft([{ id: "same", type, text: "Sindibad" }]);
    const after = draft([{ id: "same", type, text: "SINDIBAD" }]);
    const rows = screenplayDiff(before, after);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "context");
    assert.deepEqual(rows[0].oldBlock, before.blocks[0]);
    assert.equal(draftChanges(before, after).length, 0);
  }
});
test("prose casing, whitespace, element types and actual words still count as changes", () => {
  for (const [type, oldText, newText] of [
    ["action", "Hello", "HELLO"],
    ["dialogue", "Hello", "HELLO"],
    ["character", "JANE", "JUNE"],
    ["scene", "INT. ROOM", "INT.  ROOM"],
  ] as const) {
    const rows = screenplayDiff(
      draft([{ id: "same", type, text: oldText }]),
      draft([{ id: "same", type, text: newText }]),
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["removed", "added"],
    );
  }
});
