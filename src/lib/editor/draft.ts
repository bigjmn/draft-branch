import { type Draft, isElementType } from "./types";
import { toFdx } from "./fdx";
export type ExportFormat = "fountain" | "json" | "fdx";

/** Accepts the original prototype's saved drafts without changing its storage key. */
export function parseDraft(raw: string): Draft {
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("blocks" in value) ||
    !Array.isArray(value.blocks) ||
    !value.blocks.length
  ) {
    throw new Error("This saved draft is not a valid screenplay.");
  }
  const ids = new Set<string>();
  const blocks = value.blocks.map((block: unknown) => {
    if (
      !block ||
      typeof block !== "object" ||
      !("type" in block) ||
      !isElementType(block.type) ||
      !("text" in block) ||
      typeof block.text !== "string" ||
      !("id" in block) ||
      typeof block.id !== "string" ||
      !block.id ||
      ids.has(block.id)
    ) {
      throw new Error(
        "The saved draft contains invalid or duplicate elements.",
      );
    }
    ids.add(block.id);
    return { id: block.id, type: block.type, text: block.text };
  });
  return { title: value.title, blocks };
}

export function wordCount(draft: Draft): number {
  const text = draft.blocks
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text ? text.split(/\s+/u).length : 0;
}

export function toFountain(draft: Draft): string {
  let output = `Title: ${draft.title.replace(/[\r\n]+/g, " ")}\n\n`;
  for (const block of draft.blocks) {
    let text = block.text;
    if (["scene", "shot", "character", "transition"].includes(block.type))
      text = text.toUpperCase();
    if (block.type === "scene") text = `.${text}`;
    if (block.type === "character") text = `@${text}`;
    if (block.type === "transition") text = `> ${text}`;
    if (block.type === "action" || block.type === "shot") text = `!${text}`;
    if (block.type === "parenthetical" && !text.startsWith("("))
      text = `(${text})`;
    output +=
      (["dialogue", "parenthetical"].includes(block.type) ? "" : "\n") +
      text +
      "\n";
  }
  return output;
}

export function downloadDraft(draft: Draft, format: ExportFormat): void {
  const content =
    format === "json"
      ? JSON.stringify(draft, null, 2)
      : format === "fdx"
        ? toFdx(draft)
        : toFountain(draft);
  const url = URL.createObjectURL(
    new Blob([content], {
      type:
        format === "json"
          ? "application/json"
          : format === "fdx"
            ? "application/xml;charset=utf-8"
            : "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${draft.title.replace(/[^a-z0-9 _-]/gi, "") || "screenplay"}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
