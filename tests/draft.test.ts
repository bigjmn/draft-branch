import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDraft, toFountain, wordCount } from "../src/lib/editor/draft";
import { createSampleDraft } from "../src/lib/editor/sample";

test("loads legacy drafts without changing IDs, text, or element types", () => {
  const draft = createSampleDraft();
  draft.blocks[1].text = "Line one.\nLine two — with punctuation.";
  assert.deepEqual(parseDraft(JSON.stringify(draft)), draft);
});
test("rejects malformed and duplicate block identities rather than silently dropping writing", () => {
  const draft = createSampleDraft();
  assert.throws(() => parseDraft("{invalid"));
  assert.throws(() => parseDraft(JSON.stringify({ ...draft, blocks: [] })));
  assert.throws(() =>
    parseDraft(
      JSON.stringify({ ...draft, blocks: [draft.blocks[0], draft.blocks[0]] }),
    ),
  );
  assert.throws(() =>
    parseDraft(
      JSON.stringify({
        ...draft,
        blocks: [{ id: "a", text: "Preserve me", type: "unsupported" }],
      }),
    ),
  );
});
test("Fountain preserves character/dialogue adjacency, parentheticals, and forced types", () => {
  const output = toFountain({
    title: "A script",
    blocks: [
      { id: "1", type: "scene", text: "ext. ocean - dusk" },
      { id: "2", type: "character", text: "Ella" },
      { id: "3", type: "parenthetical", text: "quietly" },
      { id: "4", type: "dialogue", text: "A first line.\nA second line." },
      { id: "5", type: "transition", text: "cut to:" },
    ],
  });
  assert.match(output, /\.EXT\. OCEAN - DUSK/);
  assert.match(output, /@ELLA\n\(quietly\)\nA first line\.\nA second line\./);
  assert.match(output, /> CUT TO:/);
});
test("word count handles blank blocks and multiline dialogue", () => {
  assert.equal(
    wordCount({
      title: "Not counted",
      blocks: [{ id: "1", type: "dialogue", text: "  One\n two   three " }],
    }),
    3,
  );
  assert.equal(wordCount({ title: "Empty", blocks: [] }), 0);
});
