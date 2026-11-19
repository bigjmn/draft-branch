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
  assert.match(output, /The &quot;Light&quot; &amp; &lt;Sea&gt;/);
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
