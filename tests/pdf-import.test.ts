import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePdfPages,
  pdfLines,
  type PdfPageText,
} from "../src/lib/editor/pdf-layout";
const page = (rows: [string, number, number][]): PdfPageText => ({
  width: 612,
  height: 792,
  runs: rows.map(([text, x, y]) => ({
    text,
    x,
    y,
    width: text.length * 7.2,
    height: 12,
  })),
});
test("PDF layout detects screenplay elements, joins wraps, and removes page numbers", () => {
  const result = parsePdfPages(
    [
      page([
        ["1.", 540, 36],
        ["INT. HOME - DAY", 108, 72],
        ["A door opens.", 108, 96],
        ["ALICE", 252, 120],
        ["(quietly)", 216, 132],
        ["Hello there,", 180, 144],
        ["my friend.", 180, 156],
        ["BOB", 252, 180],
        ["Hi!", 180, 192],
        ["She leaves.", 108, 216],
        ["CUT TO:", 450, 240],
      ]),
    ],
    "Example.pdf",
  );
  assert.equal(result.draft.title, "Example");
  assert.deepEqual(
    result.draft.blocks.map((b) => b.type),
    [
      "scene",
      "action",
      "character",
      "parenthetical",
      "dialogue",
      "character",
      "dialogue",
      "action",
      "transition",
    ],
  );
  assert.equal(result.draft.blocks[4].text, "Hello there, my friend.");
});
test("PDF text fragments are grouped in visual order without spaces inside words", () => {
  const p = page([
    ["LO", 129.6, 72],
    ["HEL", 108, 72],
    ["WORLD", 151.2, 72],
  ]);
  assert.equal(pdfLines(p, 0)[0].text, "HELLO WORLD");
});
test("PDF import skips a recognizable title page and rejects scans", () => {
  const result = parsePdfPages(
    [
      page([
        ["MY SCRIPT", 216, 250],
        ["Written by", 230, 280],
      ]),
      page([
        ["INT. HOME - DAY", 108, 72],
        ["Someone arrives.", 108, 96],
      ]),
    ],
    "My script.pdf",
  );
  assert.equal(result.draft.blocks.length, 2);
  assert.throws(() => parsePdfPages([page([])], "Scan.pdf"), /OCR/);
});

test("dialogue continues across a page with no action margin on that page", () => {
  const result = parsePdfPages(
    [
      page([
        ["INT. HOME - DAY", 108, 72],
        ["ALICE", 252, 700],
        ["This sentence", 180, 712],
      ]),
      page([
        ["2.", 540, 36],
        ["continues here.", 180, 72],
      ]),
    ],
    "Continued.pdf",
  );
  assert.equal(result.draft.blocks.at(-1)?.type, "dialogue");
  assert.equal(
    result.draft.blocks.at(-1)?.text,
    "This sentence continues here.",
  );
});
