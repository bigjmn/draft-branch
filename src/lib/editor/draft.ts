import { type Draft, isElementType } from "./types";
import { toFdx } from "./fdx";
import { fountainTitlePage, parseTitlePage, titlePageOf } from "./title-page";
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
  const titlePage =
    "titlePage" in value ? parseTitlePage(value.titlePage) : undefined;
  return { title: value.title, blocks, ...(titlePage ? { titlePage } : {}) };
}

export function wordCount(draft: Draft): number {
  const text = draft.blocks
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text ? text.split(/\s+/u).length : 0;
}

/** Export options. The title page is left out unless asked for. */
export interface ExportOptions {
  titlePage?: boolean;
  /** Fills in the title page of a draft that predates title pages. */
  author?: string;
}

export function toFountain(draft: Draft, options: ExportOptions = {}): string {
  // Each element below starts with its blank line, which also ends the title page.
  const cover = options.titlePage
    ? fountainTitlePage(titlePageOf(draft, options.author))
    : "";
  let output = cover;
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
  // Without a title page the script starts at its first element.
  return cover ? output : output.replace(/^\n/, "");
}

/** JSON backups always carry the title page; FDX and Fountain only when asked. */
export function downloadDraft(
  draft: Draft,
  format: ExportFormat,
  options: ExportOptions = {},
): void {
  const content =
    format === "json"
      ? JSON.stringify(draft, null, 2)
      : format === "fdx"
        ? toFdx(draft, options)
        : toFountain(draft, options);
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
