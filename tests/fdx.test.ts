import assert from "node:assert/strict";
import { test } from "node:test";
import { toFdx } from "../src/lib/editor/fdx";
import { ELEMENT_LABELS, type Draft } from "../src/lib/editor/types";
test("FDX maps all elements, preserves order and newlines, and does not mutate the draft", () => {
  const draft: Draft = {
    title: 'The "Light" & <Sea>',
    blocks: Object.keys(ELEMENT_LABELS).map((type, i) => ({
      id: String(i),
      type: type as keyof typeof ELEMENT_LABELS,
      text:
        type === "dialogue"
          ? "First line.\nSecond line — café 🌊"
          : type === "parenthetical"
            ? "quietly"
            : "test text",
    })),
  };
  const before = JSON.stringify(draft);
  const output = toFdx(draft);
  const content = output.split("<Content>")[1].split("</Content>")[0];
  assert.deepEqual(
    [...content.matchAll(/<Paragraph Type="([^"]+)"/g)].map((m) => m[1]),
    [
      "Scene Heading",
      "Action",
      "Character",
      "Dialogue",
      "Parenthetical",
      "Shot",
      "Transition",
    ],
  );
  assert.match(content, /First line\.\nSecond line — café 🌊/);
  assert.match(content, /<Text>\(quietly\)<\/Text>/);
  assert.match(content, /<Text>TEST TEXT<\/Text>/);
  // No title page unless asked for.
  assert.doesNotMatch(output, /<TitlePage>/);
  assert.match(
    toFdx(draft, { titlePage: true }),
    /THE &quot;LIGHT&quot; &amp; &lt;SEA&gt;/,
  );
  assert.equal(JSON.stringify(draft), before);
});
test("FDX escapes markup, keeps blank elements, and replaces XML-invalid characters", () => {
  const output = toFdx({
    title: "Title",
    blocks: [
      { id: "1", type: "action", text: "</Text>&\u0000\ud800\r\nnext" },
      { id: "2", type: "dialogue", text: "" },
      { id: "3", type: "parenthetical", text: "(already wrapped)" },
    ],
  });
  assert.match(output, /&lt;\/Text&gt;&amp;��\nnext/);
  assert.match(
    output,
    /<Paragraph Type="Dialogue"><Text><\/Text><\/Paragraph>/,
  );
  assert.match(output, /<Text>\(already wrapped\)<\/Text>/);
  assert.doesNotMatch(output, /\u0000|\ud800/u);
});
test("FDX title page: title 16 lines down, credit and author centred, contact at the bottom left", () => {
  const draft: Draft = {
    title: "House",
    blocks: [{ id: "1", type: "scene", text: "INT. HOUSE - DAY" }],
    titlePage: {
      title: "THIS HOUSE IS THE WORST",
      credit: "written by",
      authors: "Jesse Nicholas",
      contact: "J Nicks Productions\n130 Hope St.\nBrooklyn, NY 11211",
    },
  };
  const page = toFdx(draft, { titlePage: true })
    .split("<TitlePage>")[1]
    .split("</TitlePage>")[0];
  const rows = [
    ...page.matchAll(
      /Alignment="(\w+)" SpaceBefore="(\d+)"><Text[^>]*>([^<]*)</g,
    ),
  ].map((m) => [m[1], Number(m[2]), m[3]]);
  assert.deepEqual(rows.slice(0, 3), [
    ["Center", 192, "THIS HOUSE IS THE WORST"],
    ["Center", 24, "written by"],
    ["Center", 24, "Jesse Nicholas"],
  ]);
  assert.deepEqual(
    rows.slice(3).map((r) => [r[0], r[2]]),
    [
      ["Left", "J Nicks Productions"],
      ["Left", "130 Hope St."],
      ["Left", "Brooklyn, NY 11211"],
    ],
  );
  // The contact block ends half an inch above the bottom margin.
  const used = rows.reduce((sum, r) => sum + (r[1] as number) + 12, 0);
  assert.equal(used, 648 - 36);
});
