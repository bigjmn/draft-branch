import { test } from "node:test";
import assert from "node:assert/strict";
import { wordDiff } from "../src/lib/projects/word-diff";

const side = (
  segments: NonNullable<ReturnType<typeof wordDiff>>,
  drop: string,
) =>
  segments
    .filter((s) => s.kind !== drop)
    .map((s) => s.text)
    .join("");

test("segments rebuild both versions exactly", () => {
  const cases: [string, string][] = [
    ["Hello there.", "Hello there, friend."],
    ["  Two  spaces\nand a newline.", "Two spaces\nand  a new line!"],
    ["Don't go — please.", "Don’t go — please, Sam."],
    ["", "Something"],
    ["Something", ""],
    ["a b c d e f", "a c d x e f g"],
  ];
  for (const [before, after] of cases) {
    const segments = wordDiff(before, after);
    assert.ok(segments, `${before} -> ${after}`);
    assert.equal(side(segments, "added"), before);
    assert.equal(side(segments, "removed"), after);
    for (let i = 1; i < segments.length; i++)
      assert.notEqual(
        segments[i].kind,
        segments[i - 1].kind,
        "runs are merged",
      );
  }
});
test("punctuation changes touch only the mark", () => {
  assert.deepEqual(wordDiff("Run.", "Run!"), [
    { kind: "same", text: "Run" },
    { kind: "removed", text: "." },
    { kind: "added", text: "!" },
  ]);
});
test("returns null for a rewrite", () => {
  assert.equal(
    wordDiff("Get out of my house.", "Fine, stay for dinner then."),
    null,
  );
});
test("long speeches with a small edit stay fast", () => {
  const words = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
  const t = performance.now();
  const segments = wordDiff(words, words.replace("word2500", "changed"));
  assert.ok(segments && segments.length === 4);
  assert.ok(performance.now() - t < 200);
});
