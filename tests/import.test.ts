import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  parseFdx,
  parseScreenplayText,
  parseClipboard,
  SCREENPLAY_MIME,
} from "../src/lib/editor/import";
import { toFdx } from "../src/lib/editor/fdx";
const window = new Window();
Object.assign(globalThis, { DOMParser: window.DOMParser });
const types = (text: string) => parseScreenplayText(text).map((b) => b.type);
test("FDX preserves types, Unicode, escaped text and text runs", () => {
  const result = parseFdx(
    '<FinalDraft><Content><Paragraph Type="Scene Heading"><Text>INT. HOME - DAY</Text></Paragraph><Paragraph Type="Action"><Text>A &amp; B </Text><Text Style="Bold">café.</Text></Paragraph></Content><TitlePage><Content><Paragraph><Text>Title</Text></Paragraph></Content></TitlePage></FinalDraft>',
  );
  assert.equal(result.draft.title, "Title");
  assert.equal(result.draft.blocks.length, 2);
  assert.equal(result.draft.blocks[1].text, "A & B café.");
  assert.deepEqual(
    parseFdx(toFdx(result.draft)).draft.blocks.map(({ type, text }) => ({
      type,
      text,
    })),
    result.draft.blocks.map(({ type, text }) => ({ type, text })),
  );
  // A title-only cover isn't treated as a title page.
  assert.equal(result.draft.titlePage, undefined);
});
test("FDX title pages round-trip", () => {
  const titlePage = {
    title: "THIS HOUSE IS THE WORST",
    credit: "written by",
    authors: "Jesse Nicholas\nSomeone Else",
    contact: "J Nicks Productions\n130 Hope St.",
  };
  const draft = {
    title: "House",
    blocks: [{ id: "a", type: "scene" as const, text: "INT. HOUSE - DAY" }],
    titlePage,
  };
  const back = parseFdx(toFdx(draft, { titlePage: true })).draft;
  assert.deepEqual(back.titlePage, titlePage);
  assert.equal(back.title, "THIS HOUSE IS THE WORST");
  // Without the title page the file name supplies the title.
  const bare = parseFdx(toFdx(draft), "House.fdx").draft;
  assert.equal(bare.title, "House");
  assert.equal(bare.titlePage, undefined);
});
test("FDX rejects entities, wrong roots and empty scripts", () => {
  for (const xml of [
    "<!DOCTYPE FinalDraft><FinalDraft/>",
    "<html/>",
    "<FinalDraft><Content/></FinalDraft>",
  ])
    assert.throws(() => parseFdx(xml));
});
test("unknown FDX elements preserve writing and warn", () => {
  const result = parseFdx(
    '<FinalDraft><Content><Paragraph Type="Lyrics"><Text>Sing!</Text></Paragraph></Content></FinalDraft>',
    "Song.fdx",
  );
  assert.equal(result.draft.title, "Song");
  assert.equal(result.draft.blocks[0].type, "action");
  assert.match(result.warnings.join(), /Lyrics/);
});
test("screenplay detection handles wrapped dialogue, parentheticals and action", () => {
  assert.deepEqual(
    types(
      "INT. HOME - DAY\n\nA door opens.\n\nJANE\n(quietly)\nHello there,\nmy friend.\n\nShe leaves.\n\nCUT TO:",
    ),
    [
      "scene",
      "action",
      "character",
      "parenthetical",
      "dialogue",
      "action",
      "transition",
    ],
  );
  assert.equal(
    parseScreenplayText("JANE\nHello there,\nmy friend.")[1].text,
    "Hello there, my friend.",
  );
});
test("forced Fountain types and caps action", () => {
  assert.deepEqual(types(".THE VOID\n\n!BOOM\n\n@Jane\nHello."), [
    "scene",
    "action",
    "character",
    "dialogue",
  ]);
  assert.deepEqual(types("THE DOOR SLAMS.\nGlass falls."), ["action"]);
});
test("clipboard metadata takes precedence and regenerates IDs", () => {
  const data = {
    getData: (key: string) =>
      key === SCREENPLAY_MIME
        ? JSON.stringify([{ id: "old", type: "shot", text: "CLOSE UP" }])
        : "",
  };
  const result = parseClipboard(data, "action")!;
  assert.equal(result[0].type, "shot");
  assert.notEqual(result[0].id, "old");
});
test("HTML preserves explicit elements safely and ordinary inline text stays inline", () => {
  const result = parseClipboard(
    {
      getData: (key) =>
        key === "text/html"
          ? '<p data-type="character">JANE</p><p data-type="dialogue">Hi<br>there<script>bad()</script></p>'
          : "",
    },
    "action",
  )!;
  assert.deepEqual(
    result.map((b) => b.type),
    ["character", "dialogue"],
  );
  assert.equal(result[1].text, "Hi\nthere");
  assert.equal(
    parseClipboard(
      { getData: (key) => (key === "text/plain" ? "hello" : "") },
      "dialogue",
    ),
    null,
  );
});

test("structured paste preserves surrounding text, supports undo/redo, and readonly blocks ignore paste", async () => {
  const { ScreenplayEngine } = await import("../src/lib/editor/engine");
  Object.assign(globalThis, {
    Text: window.Text,
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLDivElement: window.HTMLDivElement,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  const root = window.document.createElement("div");
  window.document.body.append(root);
  let saved: { text: string; type: string }[] = [];
  const initial = [{ id: "a", type: "action" as const, text: "Before AFTER" }];
  const engine = new ScreenplayEngine(
    root as unknown as HTMLDivElement,
    initial,
    { onChange: (b) => (saved = b), onSelection: () => {}, onLayout: () => {} },
  );
  const first = root.querySelector(".block")!;
  const range = window.document.createRange();
  range.setStart(first.firstChild!, 7);
  range.collapse(true);
  window.getSelection().addRange(range);
  const clipboard = new window.DataTransfer();
  clipboard.setData(
    SCREENPLAY_MIME,
    JSON.stringify([
      { type: "character", text: "JANE" },
      { type: "dialogue", text: "Hello." },
    ]),
  );
  first.dispatchEvent(
    new window.ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }),
  );
  assert.deepEqual(
    saved.map((b) => b.text),
    ["Before ", "JANE", "Hello.", "AFTER"],
  );
  root.querySelector(".block")!.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "z",
      ctrlKey: true,
    }),
  );
  assert.deepEqual(
    saved.map((b) => b.text),
    ["Before AFTER"],
  );
  root.querySelector(".block")!.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "z",
      ctrlKey: true,
      shiftKey: true,
    }),
  );
  assert.equal(saved.length, 4);
  engine.destroy();
  const reader = new ScreenplayEngine(
    root as unknown as HTMLDivElement,
    initial,
    {
      onChange: () => assert.fail("Reader mutated"),
      onSelection: () => {},
      onLayout: () => {},
    },
    true,
  );
  root.querySelector(".block")!.dispatchEvent(
    new window.ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }),
  );
  assert.equal(root.querySelector(".block")!.textContent, "Before AFTER");
  reader.destroy();
  root.remove();
});

test("FDX spacer actions do not become extra editor elements", () => {
  const { draft } = parseFdx(`<FinalDraft><Content>
    <Paragraph Type="Action"/>
    <Paragraph Type="Scene Heading"><Text>INT. HOUSE - DAY</Text></Paragraph>
    <Paragraph Type="Action"><Text> \t&#160;&#8203;</Text></Paragraph>
    <Paragraph Type="Action"><Text>A door opens.</Text></Paragraph>
    <Paragraph Type="Character"><Text>JANE</Text></Paragraph>
    <Paragraph Type="Dialogue"><Text>Hello.</Text></Paragraph>
    <Paragraph Type="Action"><Text></Text></Paragraph>
    <Paragraph Type="Dialogue"><Text></Text></Paragraph>
  </Content></FinalDraft>`);
  assert.deepEqual(
    draft.blocks.map((b) => b.type),
    ["scene", "action", "character", "dialogue", "dialogue"],
  );
  assert.equal(draft.blocks[1].text, "A door opens.");
});

test("FDX title-page spacer punctuation is not used as the project title", () => {
  const file = (title: string) =>
    `<FinalDraft><Content><Paragraph Type="Action"><Text>A ship sails.</Text></Paragraph></Content><TitlePage><Content><Paragraph><Text>.</Text></Paragraph>${title}</Content></TitlePage></FinalDraft>`;
  assert.equal(parseFdx(file(""), "Sindibad.fdx").draft.title, "Sindibad");
  assert.equal(
    parseFdx(file("<Paragraph><Text>Sindibad</Text></Paragraph>"), "script.fdx")
      .draft.title,
    "Sindibad",
  );
});
