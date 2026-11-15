import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDraft, toFountain, wordCount } from "../src/lib/editor/draft";
import { createBlankDraft, createSampleDraft } from "../src/lib/editor/sample";
import {
  NEXT_ELEMENT,
  cycleElement,
  unwrapParenthetical,
  wrapParenthetical,
  type ElementType,
} from "../src/lib/editor/types";

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
test("Enter after dialogue starts an action line; after a character, dialogue", () => {
  assert.equal(NEXT_ELEMENT.dialogue, "action");
  assert.equal(NEXT_ELEMENT.character, "dialogue");
});
test("Tab cycles general lines and dialogue lines in separate groups", () => {
  const forward = (start: ElementType, steps: number) =>
    Array.from({ length: steps }).reduce<ElementType[]>(
      (seen) => [...seen, cycleElement(seen.at(-1)!, 1)],
      [start],
    );
  assert.deepEqual(forward("action", 4), [
    "action",
    "character",
    "transition",
    "scene",
    "action",
  ]);
  assert.deepEqual(forward("dialogue", 2), [
    "dialogue",
    "parenthetical",
    "dialogue",
  ]);
  assert.equal(cycleElement("action", -1), "scene");
  assert.equal(cycleElement("shot", 1), "action");
});
test("parenthetical wrapping places and preserves the caret", () => {
  assert.deepEqual(wrapParenthetical({ text: "", offset: 0 }), {
    text: "()",
    offset: 1,
  });
  assert.deepEqual(wrapParenthetical({ text: "quietly", offset: 7 }), {
    text: "(quietly)",
    offset: 8,
  });
  assert.deepEqual(wrapParenthetical({ text: "(beat)", offset: 3 }), {
    text: "(beat)",
    offset: 3,
  });
  assert.deepEqual(unwrapParenthetical({ text: "()", offset: 1 }), {
    text: "",
    offset: 0,
  });
  assert.deepEqual(unwrapParenthetical({ text: "(beat)", offset: 5 }), {
    text: "beat",
    offset: 4,
  });
});

test("a blank project is one empty scene heading that survives a save", () => {
  const blank = createBlankDraft();
  assert.equal(blank.blocks.length, 1);
  assert.equal(blank.blocks[0].type, "scene");
  assert.equal(blank.blocks[0].text, "");
  assert.deepEqual(parseDraft(JSON.stringify(blank)), blank);
  assert.notEqual(createBlankDraft().blocks[0].id, blank.blocks[0].id);
});
