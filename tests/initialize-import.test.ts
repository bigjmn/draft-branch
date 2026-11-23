import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeImportedProject } from "../src/lib/projects/initialize-import";
const draft = {
  title: "Pilot",
  blocks: [{ id: "a", type: "scene" as const, text: "INT. HOUSE - DAY" }],
};
const initial = {
  draft: {
    title: "Pilot",
    blocks: [{ id: "blank", type: "scene" as const, text: "" }],
  },
  version: 0,
  head: "first",
  baseCommit: "first",
};
test("current backend imported content needs no second upload", async () => {
  await initializeImportedProject(
    "first",
    draft,
    async () => ({ ...initial, draft }),
    async () => {
      throw new Error("Unexpected overwrite");
    },
  );
});
test("older backend is repaired through verified upload before returning", async () => {
  let loaded = initial;
  let saves = 0;
  await initializeImportedProject(
    "first",
    draft,
    async () => loaded,
    async () => {
      saves++;
      loaded = { ...initial, draft, version: 1 };
      return { status: "accepted" };
    },
  );
  assert.equal(saves, 1);
  await initializeImportedProject(
    "first",
    draft,
    async () => loaded,
    async () => {
      throw new Error("Duplicate upload");
    },
  );
});
test("existing writing and rejected uploads cannot silently open an empty editor", async () => {
  await assert.rejects(
    () =>
      initializeImportedProject(
        "first",
        draft,
        async () => ({ ...initial, version: 2 }),
        async () => {
          throw new Error("Would overwrite");
        },
      ),
    /protect/,
  );
  await assert.rejects(
    () =>
      initializeImportedProject(
        "first",
        draft,
        async () => initial,
        async () => ({ status: "rejected" }),
      ),
    /could not be confirmed/,
  );
  await assert.rejects(
    () =>
      initializeImportedProject(
        "first",
        draft,
        async () => initial,
        async () => ({ status: "accepted" }),
      ),
    /could not be confirmed/,
  );
});
