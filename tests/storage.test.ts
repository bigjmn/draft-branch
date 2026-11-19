import test from "node:test";
import assert from "node:assert/strict";
import { readStoredValue } from "../src/lib/storage";

test("renamed storage preserves old guest drafts, branch recovery, and theme preferences", () => {
  for (const suffix of [
    "editor.v1",
    "project.v1.alice.project.alternate",
    "theme",
  ]) {
    const saved = new Map([[`scriptroom.${suffix}`, "original data"]]);
    const storage = { getItem: (key: string) => saved.get(key) ?? null };
    assert.equal(
      readStoredValue(storage, `draftbranch.${suffix}`),
      "original data",
    );
    assert.equal(saved.size, 1);
    saved.set(`draftbranch.${suffix}`, "newer data");
    assert.equal(
      readStoredValue(storage, `draftbranch.${suffix}`),
      "newer data",
    );
    assert.equal(saved.get(`scriptroom.${suffix}`), "original data");
  }
});
test("missing storage is empty, and an existing empty value does not resurrect old data", () => {
  assert.equal(
    readStoredValue({ getItem: () => null }, "draftbranch.editor.v1"),
    null,
  );
  assert.equal(
    readStoredValue(
      { getItem: (key) => (key.startsWith("draftbranch.") ? "" : "old") },
      "draftbranch.editor.v1",
    ),
    "",
  );
});
