import type { Draft, TitlePage } from "./types";
import {
  TITLE_PAGE_FIELDS,
  TITLE_PAGE_LIMITS,
  type TitlePageField,
} from "@/lib/projects/merge";

export { TITLE_PAGE_FIELDS, TITLE_PAGE_LIMITS, type TitlePageField };

export const TITLE_PAGE_LABELS: Record<TitlePageField, string> = {
  title: "Title",
  credit: "Credit",
  authors: "Author",
  contact: "Contact",
};
export const TITLE_PAGE_PLACEHOLDERS: Record<TitlePageField, string> = {
  title: "TITLE",
  credit: "written by",
  authors: "Your name",
  contact: "Company\nAddress\nPhone\nEmail",
};

/** Matches the backend's defaultTitlePage (functions/src/projects/model.ts),
 * which fills in a new project's title page. */
export function defaultTitlePage(title: string, author: string): TitlePage {
  const name = title.trim();
  return {
    title: (!name || /^untitled( screenplay)?$/i.test(name) ? "Untitled" : name)
      .toUpperCase()
      .slice(0, TITLE_PAGE_LIMITS.title),
    credit: "written by",
    authors: author
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, TITLE_PAGE_LIMITS.authors),
    contact: "Company\nAddress\nPhone\nEmail",
  };
}

/** The draft's title page. Drafts saved before title pages existed get the
 * default, which is only stored once someone edits it. */
export function titlePageOf(draft: Draft, author = ""): TitlePage {
  return draft.titlePage ?? defaultTitlePage(draft.title, author);
}

/** A stored title page, or undefined if the value isn't one. */
export function parseTitlePage(value: unknown): TitlePage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const page = value as Record<string, unknown>;
  const result = {} as TitlePage;
  for (const field of TITLE_PAGE_FIELDS) {
    const text = page[field];
    if (typeof text !== "string" || text.length > TITLE_PAGE_LIMITS[field])
      return undefined;
    result[field] = text;
  }
  return result;
}

export function sameTitlePage(a?: TitlePage, b?: TitlePage): boolean {
  if (!a || !b) return a === b;
  return TITLE_PAGE_FIELDS.every((field) => a[field] === b[field]);
}

const lines = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

/** Fountain's title page: key/value pairs, with indented continuation lines. */
export function fountainTitlePage(page: TitlePage): string {
  const entry = (key: string, text: string) => {
    const rows = lines(text).filter(
      (line, i, all) => line || i < all.length - 1,
    );
    if (!rows.some(Boolean)) return "";
    return rows.length === 1
      ? `${key}: ${rows[0]}\n`
      : `${key}:\n${rows.map((row) => `   ${row}`).join("\n")}\n`;
  };
  return (
    entry("Title", page.title) +
    entry("Credit", page.credit) +
    entry("Author", page.authors) +
    entry("Contact", page.contact)
  );
}

/** One line of the FDX title page. */
export interface TitlePageLine {
  text: string;
  align: "Center" | "Left";
  /** Points of space before the line. */
  before: number;
}
/** The title page as Final Draft paragraphs, laid out like a standard cover:
 * the title 16 lines down, two blank lines before the credit and the author,
 * and the contact lines at the left, ending half an inch above the margin. */
export function titlePageLines(page: TitlePage): TitlePageLine[] {
  const out: TitlePageLine[] = [];
  const add = (text: string, align: TitlePageLine["align"], before: number) =>
    lines(text).forEach((line, i) =>
      out.push({ text: line, align, before: i ? 0 : before }),
    );
  add(page.title, "Center", 192);
  if (page.credit.trim()) add(page.credit, "Center", 24);
  if (page.authors.trim()) add(page.authors, "Center", 24);
  const used = out.reduce((sum, line) => sum + line.before + 12, 0);
  const contact = page.contact.trim() ? lines(page.contact.trim()) : [];
  // 9 inches of text (648 pt), less what's above, the contact block and the
  // half inch kept free under it.
  if (contact.length)
    add(
      contact.join("\n"),
      "Left",
      Math.max(24, 648 - 36 - used - contact.length * 12),
    );
  return out;
}
