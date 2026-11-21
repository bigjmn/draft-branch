import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { editorText } from "../src/lib/editor/dom-text";
const window = new Window();
test("reading styled screenplay elements never changes their stored case", () => {
  const el = window.document.createElement("div");
  el.style.textTransform = "uppercase";
  el.textContent = "Sindibad";
  Object.defineProperty(el, "innerText", { get: () => "SINDIBAD" });
  assert.equal(editorText(el as unknown as Node), "Sindibad");
});
test("editable DOM preserves soft breaks, paragraph boundaries, blank lines and plain newlines", () => {
  for (const [html, expected] of [
    ["First<br>second", "First\nsecond"],
    ["First<div>second</div>", "First\nsecond"],
    ["First<div><br></div><div>third</div>", "First\n\nthird"],
    ["<div>First</div><div>second</div>", "First\nsecond"],
    ["<br>", ""],
    ["First\nsecond", "First\nsecond"],
  ]) {
    const el = window.document.createElement("div");
    el.innerHTML = html;
    assert.equal(editorText(el as unknown as Node), expected);
  }
});
