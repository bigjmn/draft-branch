import {
  isElementType,
  type Draft,
  type ElementType,
  type ScriptBlock,
} from "./types";

export const SCREENPLAY_MIME = "application/x-draftbranch-elements+json";
const MAX_BYTES = 2 * 1024 * 1024;
const names: Record<string, ElementType> = {
  "scene heading": "scene",
  action: "action",
  character: "character",
  dialogue: "dialogue",
  parenthetical: "parenthetical",
  shot: "shot",
  transition: "transition",
};
export function elementType(value: string): ElementType | undefined {
  const key = value.toLowerCase().trim();
  return isElementType(key) ? key : names[key];
}
function checkSize(text: string) {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error("Screenplay exceeds the 2 MiB limit.");
}
function block(type: ElementType, text: string): ScriptBlock {
  return { id: crypto.randomUUID(), type, text };
}
export function validateImport(draft: Draft): Draft {
  if (
    !draft.blocks.length ||
    draft.blocks.length > 10000 ||
    draft.blocks.some((b) => b.text.length > 100000)
  )
    throw new Error(
      "A screenplay must contain 1–10,000 elements, each under 100,000 characters.",
    );
  checkSize(JSON.stringify(draft));
  return draft;
}
export function parseFdx(
  xml: string,
  filename = "Untitled screenplay.fdx",
): { draft: Draft; warnings: string[] } {
  checkSize(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error(
      "FDX files containing document types or entities are not supported.",
    );
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.tagName !== "FinalDraft"
  )
    throw new Error("This is not a valid Final Draft (.fdx) screenplay.");
  const root = doc.documentElement;
  const content = Array.from(root.children).find(
    (e) => e.tagName === "Content",
  );
  if (!content) throw new Error("The FDX file has no screenplay content.");
  const warnings = new Set<string>();
  const text = (el: Element) =>
    Array.from(el.children)
      .filter((e) => e.tagName === "Text")
      .map((e) => e.textContent ?? "")
      .join("")
      .replace(/\r\n?/g, "\n");
  const blocks = Array.from(content.querySelectorAll("Paragraph"))
    .filter((e) => !e.closest("ScriptNote"))
    .map((el) => {
      const raw = el.getAttribute("Type") ?? "Action";
      const type = elementType(raw);
      if (!type)
        warnings.add(`“${raw}” paragraphs will be imported as action.`);
      return block(type ?? "action", text(el));
    })
    // FDX often uses empty Action paragraphs as layout spacers. The editor
    // supplies paragraph spacing itself, so importing these doubles the gaps.
    .filter(
      (b) =>
        b.type !== "action" ||
        b.text.replace(/[\s\u200B\uFEFF]/g, "").length > 0,
    );
  if (content.querySelector("DualDialogue"))
    warnings.add("Side-by-side dialogue will be imported in reading order.");
  const titlePage = Array.from(root.children).find(
    (e) => e.tagName === "TitlePage",
  );
  const title =
    Array.from(titlePage?.querySelectorAll("Paragraph") ?? [])
      .map(text)
      .find((t) => /[\p{L}\p{N}]/u.test(t))
      ?.trim() ||
    filename.replace(/\.fdx$/i, "").trim() ||
    "Untitled screenplay";
  warnings.add(
    "Text and screenplay element types are preserved. Custom fonts, emphasis, notes, and revision marks are not imported.",
  );
  return {
    draft: validateImport({ title: title.slice(0, 200), blocks }),
    warnings: [...warnings],
  };
}
export async function readFdx(file: File) {
  if (!/\.fdx$/i.test(file.name))
    throw new Error("Choose a Final Draft (.fdx) file.");
  if (file.size > MAX_BYTES)
    throw new Error("Choose an FDX file smaller than 2 MiB.");
  return parseFdx(await file.text(), file.name);
}

/** Plain screenplay / Fountain fallback. Blank lines separate action from dialogue;
 * hard-wrapped lines within a paragraph are joined. Explicit markers win. */
export function parseScreenplayText(
  value: string,
  context: ElementType = "action",
): ScriptBlock[] {
  checkSize(value);
  const lines = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n");
  const out: ScriptBlock[] = [];
  let dialogue =
    context === "dialogue" ||
    context === "parenthetical" ||
    context === "character";
  let separated = true;
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].trim();
    if (!text) {
      separated = true;
      dialogue = false;
      continue;
    }
    let type: ElementType;
    const next = lines[i + 1]?.trim();
    // Character cues in PDF/plain clipboard text are often more indented than
    // their dialogue, even when blank paragraph separators have been lost.
    const indent = (line: string) => line.replace(/\t/g, "    ").search(/\S/);
    const indentedCue =
      !!next &&
      indent(lines[i]) >= 8 &&
      indent(lines[i]) > indent(lines[i + 1]);
    if (
      /^(?:INT\.?|EXT\.?|INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?)\s/i.test(
        text,
      ) ||
      /^\.[^.]/.test(text)
    ) {
      type = "scene";
      text = text.replace(/^\./, "");
      dialogue = false;
    } else if (
      /^>[^<]*$/.test(text) ||
      /^(?:FADE (?:IN|OUT)[.:]|FADE TO BLACK[.:]?|.* TO:)$/i.test(text)
    ) {
      type = "transition";
      text = text.replace(/^>\s*/, "");
      dialogue = false;
    } else if (text.startsWith("!")) {
      type = "action";
      text = text.slice(1);
      dialogue = false;
    } else if (
      text.startsWith("@") ||
      ((separated || indentedCue) &&
        !!next &&
        text.length <= 60 &&
        /[A-Z]/.test(text) &&
        text === text.toUpperCase() &&
        !/[.!?:]$/.test(text) &&
        !/^(INT|EXT)\b/.test(next))
    ) {
      type = "character";
      text = text.replace(/^@/, "").replace(/\s+\^$/, "");
      dialogue = true;
    } else if (dialogue && /^\(.*\)$/.test(text)) type = "parenthetical";
    else type = dialogue ? "dialogue" : "action";
    const last = out.at(-1);
    if (
      !separated &&
      last?.type === type &&
      (type === "action" || type === "dialogue")
    )
      last.text += " " + text;
    else out.push(block(type, text));
    separated = false;
  }
  return out;
}

export function parseClipboard(
  data: Pick<DataTransfer, "getData">,
  context: ElementType,
): ScriptBlock[] | null {
  const plain = data.getData("text/plain");
  checkSize(plain);
  const custom = data.getData(SCREENPLAY_MIME);
  if (custom) {
    checkSize(custom);
    try {
      const items: unknown = JSON.parse(custom);
      if (
        Array.isArray(items) &&
        items.length &&
        items.every(
          (b) => b && isElementType(b.type) && typeof b.text === "string",
        )
      )
        return validateImport({
          title: "",
          blocks: items.map((b) => block(b.type, b.text)),
        }).blocks;
    } catch {
      /* Other applications can supply malformed metadata; fall back. */
    }
  }
  const html = data.getData("text/html");
  if (html) {
    checkSize(html);
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc
      .querySelectorAll("script,style,template,iframe,object,[hidden]")
      .forEach((e) => e.remove());
    doc.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
    const paragraphs = Array.from(doc.body.querySelectorAll("p,div,li")).filter(
      (e) => !e.querySelector("p,div,li"),
    );
    const typed = paragraphs.map((el) => ({
      type: elementType(
        el.getAttribute("data-type") ||
          el.getAttribute("data-element-type") ||
          el.getAttribute("type") ||
          "",
      ),
      text: el.textContent ?? "",
    }));
    if (typed.length && typed.every((b) => b.type))
      return validateImport({
        title: "",
        blocks: typed.map((b) => block(b.type!, b.text)),
      }).blocks;
  }
  // A normal inline paste keeps its current element and the browser's undo behavior.
  if (!plain.includes("\n") && !plain.includes("\r")) return null;
  return parseScreenplayText(plain, context);
}
