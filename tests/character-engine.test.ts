import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { ScreenplayEngine } from "../src/lib/editor/engine";
import type { ScriptBlock } from "../src/lib/editor/types";

test("character menu handles keyboard selection, dismissal, history, and readonly", () => {
  const win = new Window();
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLDivElement: win.HTMLDivElement,
    HTMLElement: win.HTMLElement,
    Text: win.Text,
    getComputedStyle: win.getComputedStyle.bind(win),
  });
  const root = win.document.createElement("div");
  win.document.body.append(root);
  const initial: ScriptBlock[] = [
    { id: "1", type: "character", text: "ALICE" },
    { id: "2", type: "dialogue", text: "Hello" },
    { id: "3", type: "character", text: "BOB" },
    { id: "4", type: "dialogue", text: "Hi" },
    { id: "5", type: "character", text: "ALISON" },
    { id: "6", type: "action", text: "Walks away." },
    { id: "7", type: "character", text: "" },
  ];
  let saved = initial;
  const engine = new ScreenplayEngine(
    root as unknown as HTMLDivElement,
    initial,
    { onChange: (b) => (saved = b), onSelection: () => {}, onLayout: () => {} },
  );
  const cue = root.querySelector('[data-id="7"]')! as unknown as HTMLDivElement;
  cue.focus();
  assert.equal(cue.dataset.suggestion, "ALICE (Enter)");
  assert.equal(cue.textContent, "");
  const key = (value: string) =>
    cue.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }) as unknown as KeyboardEvent,
    );
  key("ArrowRight");
  assert.equal(win.document.querySelector('[role="listbox"]'), null);
  cue.textContent = "AL";
  cue.dispatchEvent(
    new win.Event("input", { bubbles: true }) as unknown as Event,
  );
  assert.equal(win.document.querySelectorAll('[role="option"]').length, 2);
  key("ArrowDown");
  key("ArrowUp");
  key("ArrowDown");
  key("Enter");
  assert.equal(cue.textContent, "ALISON");
  assert.equal(
    (win.document.activeElement as unknown as HTMLElement).dataset.type,
    "dialogue",
  );
  assert.equal(saved.at(-1)?.type, "dialogue");
  assert.equal(win.document.querySelector('[role="listbox"]'), null);
  win.document.activeElement!.dispatchEvent(
    new win.KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
    }),
  );
  assert.equal(root.querySelector('[data-id="7"]')?.textContent, "AL");
  engine.destroy();
  const reader = new ScreenplayEngine(
    root as unknown as HTMLDivElement,
    initial,
    {
      onChange: () => {
        throw new Error("readonly mutation");
      },
      onSelection: () => {},
      onLayout: () => {},
    },
    true,
  );
  (root.querySelector('[data-id="7"]') as unknown as HTMLElement).focus();
  assert.equal(win.document.querySelector('[role="listbox"]'), null);
  reader.destroy();
  win.happyDOM.abort();
});
