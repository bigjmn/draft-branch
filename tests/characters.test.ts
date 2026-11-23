import { test } from "node:test";
import assert from "node:assert/strict";
import { characterSuggestions } from "../src/lib/editor/characters";
import type { ScriptBlock } from "../src/lib/editor/types";
const blocks: ScriptBlock[] = [
  { id: "a", type: "character", text: "Alice" },
  { id: "b", type: "dialogue", text: "Hello." },
  { id: "c", type: "character", text: "BOB" },
  { id: "d", type: "parenthetical", text: "(quietly)" },
  { id: "e", type: "dialogue", text: "Hi." },
  { id: "f", type: "character", text: "" },
  { id: "g", type: "character", text: "ALISON" },
  { id: "h", type: "character", text: "ALICE (CONT’D)" },
];
test("empty cues suggest the second-to-last person who actually spoke", () => {
  assert.deepEqual(characterSuggestions(blocks, "f", ""), ["ALICE"]);
  assert.deepEqual(characterSuggestions(blocks, "c", ""), []);
});
test("typed suggestions filter, deduplicate, and ignore the active cue", () => {
  assert.deepEqual(characterSuggestions(blocks, "f", "al"), [
    "ALICE",
    "ALISON",
  ]);
  assert.deepEqual(characterSuggestions(blocks, "f", "Z"), []);
});
