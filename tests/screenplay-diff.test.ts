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
    rows
      .filter((r) => r.kind !== "added")
      .map((r) => (r.kind === "changed" ? r.oldBlock : r.block)),
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
    // Shown as an in-place edit (or removed + added): never as unchanged.
    assert.ok(rows.length > 0 && rows.every((r) => r.kind !== "context"));
  }
});

test("text added to a speech is one edited row, with only the new words marked", () => {
  const cue: ScriptBlock = { id: "c", type: "character", text: "MAYA" };
  const line = (text: string): ScriptBlock => ({
    id: "d",
    type: "dialogue",
    text,
  });
  const before = draft([cue, line("I told you we should have left early.")]);
  const after = draft([
    cue,
    line("I told you we should have left early. Nobody listens to me."),
  ]);
  reconstruct(before, after);
  const rows = screenplayDiff(before, after);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["context", "changed"],
  );
  assert.deepEqual(rows[1].segments, [
    { kind: "same", text: "I told you we should have left early." },
    { kind: "added", text: " Nobody listens to me." },
  ]);
  assert.deepEqual([rows[1].oldNumber, rows[1].newNumber], [2, 2]);
});
test("edits in the middle of a speech mark removed and added words in place", () => {
  const before = draft([
    { id: "d", type: "dialogue", text: "We leave at dawn, not before." },
  ]);
  const after = draft([
    { id: "d", type: "dialogue", text: "We leave at noon, not before." },
  ]);
  const [row] = screenplayDiff(before, after);
  assert.equal(row.kind, "changed");
  assert.deepEqual(row.segments, [
    { kind: "same", text: "We leave at " },
    { kind: "removed", text: "dawn" },
    { kind: "added", text: "noon" },
    { kind: "same", text: ", not before." },
  ]);
});
test("a rewrite or a change of element type stays a removed row plus an added row", () => {
  const rewrite = screenplayDiff(
    draft([{ id: "d", type: "dialogue", text: "Get out of my house." }]),
    draft([{ id: "d", type: "dialogue", text: "Fine, stay for dinner then." }]),
  );
  assert.deepEqual(
    rewrite.map((r) => r.kind),
    ["removed", "added"],
  );
  const retyped = screenplayDiff(
    draft([{ id: "d", type: "dialogue", text: "She runs." }]),
    draft([{ id: "d", type: "action", text: "She runs away." }]),
  );
  assert.deepEqual(
    retyped.map((r) => r.kind),
    ["removed", "added"],
  );
});
test("filling in an empty element or emptying one is shown as an edit", () => {
  const filled = screenplayDiff(
    draft([{ id: "d", type: "dialogue", text: "" }]),
    draft([{ id: "d", type: "dialogue", text: "Hello?" }]),
  );
  assert.equal(filled[0].kind, "changed");
  assert.deepEqual(filled[0].segments, [{ kind: "added", text: "Hello?" }]);
});
test("edited rows count as changes when folding unchanged context", () => {
  const blocks = Array.from({ length: 20 }, (_, i) =>
    block(String(i), `Line ${i} of the scene.`),
  );
  const after = blocks.map((b) =>
    b.id === "10" ? { ...b, text: "Line 10 of the long scene." } : b,
  );
  const sections = foldDiff(screenplayDiff(draft(blocks), draft(after)));
  const shown = sections
    .filter((s) => s.kind === "rows")
    .flatMap((s) => s.rows);
  assert.ok(shown.some((r) => r.kind === "changed"));
  assert.equal(sections.filter((s) => s.kind === "fold").length, 2);
});
