import { sameScreenplayElement } from "./element-equality";
import { wordDiff, type TextSegment } from "./word-diff";
import type { Draft, ScriptBlock } from "@/lib/editor/types";
import { TITLE_PAGE_FIELDS } from "./merge";

const TITLE_PAGE_LABELS = {
  title: "Title page · Title",
  credit: "Title page · Credit",
  authors: "Title page · Author",
  contact: "Title page · Contact",
} as const;
export interface DiffRow {
  /** "changed": the same element with edited text, shown once with the
   * edits marked inline (block is the new version, oldBlock the old). */
  kind: "context" | "added" | "removed" | "changed";
  block: ScriptBlock;
  oldNumber?: number;
  newNumber?: number;
  /** Not a script element: the title, or a title page field. */
  title?: boolean;
  /** What a title row is, e.g. "Title" or "Title page · Author". */
  label?: string;
  /** Original text when a context row differs only in display-equivalent
   * casing, and the old version of a changed row. */
  oldBlock?: ScriptBlock;
  /** For changed rows: the text split into kept, removed and added runs. */
  segments?: TextSegment[];
}
/** Align stable IDs with an O(n log n) longest increasing subsequence.
 * Moved elements appear once at their old position and once at their new position.
 * Context rows retain oldBlock when raw text differs but rendering is equivalent.
 * An element whose type is unchanged but whose text was edited becomes one
 * "changed" row with word-level segments, unless the edit is a near rewrite,
 * which stays a removed row plus an added row. */
export function screenplayDiff(before: Draft, after: Draft): DiffRow[] {
  const rows: DiffRow[] = [];
  if (before.title !== after.title) {
    rows.push({
      kind: "removed",
      title: true,
      block: { id: "title", type: "action", text: before.title },
    });
    rows.push({
      kind: "added",
      title: true,
      block: { id: "title", type: "action", text: after.title },
    });
  }
  if (
    before.title === after.title &&
    before.title &&
    !before.blocks.length &&
    !after.blocks.length
  ) {
    rows.push({
      kind: "context",
      title: true,
      block: { id: "title", type: "action", text: before.title },
    });
  }
  // Title page fields come before the script, edited ones word by word.
  for (const field of TITLE_PAGE_FIELDS) {
    const from = before.titlePage?.[field] ?? "",
      to = after.titlePage?.[field] ?? "";
    if (from === to) continue;
    const block = (text: string): ScriptBlock => ({
      id: `titlepage:${field}`,
      type: "action",
      text,
    });
    const label = TITLE_PAGE_LABELS[field];
    if (from && to) {
      const segments = wordDiff(from, to);
      if (segments)
        rows.push({
          kind: "changed",
          title: true,
          label,
          block: block(to),
          oldBlock: block(from),
          segments,
        });
      else {
        rows.push({ kind: "removed", title: true, label, block: block(from) });
        rows.push({ kind: "added", title: true, label, block: block(to) });
      }
    } else
      rows.push({
        kind: from ? "removed" : "added",
        title: true,
        label,
        block: block(from || to),
      });
  }
  const old = new Map(before.blocks.map((b, i) => [b.id, i]));
  const shared = after.blocks.flatMap((b, j) =>
    old.has(b.id) ? [{ i: old.get(b.id)!, j }] : [],
  );
  const tails: number[] = [],
    previous: number[] = [];
  shared.forEach((item, k) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (shared[tails[mid]].i < item.i) lo = mid + 1;
      else hi = mid;
    }
    previous[k] = lo ? tails[lo - 1] : -1;
    tails[lo] = k;
  });
  const anchors: { i: number; j: number }[] = [];
  for (
    let k = tails.length ? tails[tails.length - 1] : -1;
    k >= 0;
    k = previous[k]
  )
    anchors.push(shared[k]);
  anchors.reverse();
  anchors.push({ i: before.blocks.length, j: after.blocks.length });
  let i = 0,
    j = 0;
  for (const anchor of anchors) {
    while (i < anchor.i) {
      rows.push({ kind: "removed", block: before.blocks[i], oldNumber: i + 1 });
      i++;
    }
    while (j < anchor.j) {
      rows.push({ kind: "added", block: after.blocks[j], newNumber: j + 1 });
      j++;
    }
    if (i === before.blocks.length) break;
    const a = before.blocks[i],
      b = after.blocks[j];
    if (sameScreenplayElement(a, b))
      rows.push({
        kind: "context",
        block: b,
        ...(a.text !== b.text ? { oldBlock: a } : {}),
        oldNumber: i + 1,
        newNumber: j + 1,
      });
    else {
      const segments = a.type === b.type ? wordDiff(a.text, b.text) : null;
      if (segments)
        rows.push({
          kind: "changed",
          block: b,
          oldBlock: a,
          segments,
          oldNumber: i + 1,
          newNumber: j + 1,
        });
      else {
        rows.push({ kind: "removed", block: a, oldNumber: i + 1 });
        rows.push({ kind: "added", block: b, newNumber: j + 1 });
      }
    }
    i++;
    j++;
  }
  return rows;
}
export type DiffSection = { kind: "rows" | "fold"; rows: DiffRow[] };
/** Keep three unchanged elements beside each change, folding only longer gaps. */
export function foldDiff(rows: DiffRow[], context = 3): DiffSection[] {
  const sections: DiffSection[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    const unchanged = rows[start].kind === "context";
    while (end < rows.length && (rows[end].kind === "context") === unchanged)
      end++;
    const run = rows.slice(start, end);
    let leading = start > 0 ? Math.min(context, run.length) : 0;
    let trailing = end < rows.length ? Math.min(context, run.length) : 0;
    // Avoid showing dialogue without its cue, or folding half of a speech.
    const speech = (row: DiffRow) =>
      ["dialogue", "parenthetical"].includes(row.block.type);
    while (leading && leading < run.length && speech(run[leading])) leading++;
    while (
      trailing &&
      trailing < run.length &&
      speech(run[run.length - trailing])
    )
      trailing++;

    if (unchanged && run.length > leading + trailing + 2) {
      if (leading) sections.push({ kind: "rows", rows: run.slice(0, leading) });
      sections.push({
        kind: "fold",
        rows: run.slice(leading, run.length - trailing),
      });
      if (trailing) sections.push({ kind: "rows", rows: run.slice(-trailing) });
    } else sections.push({ kind: "rows", rows: run });
    start = end;
  }
  return sections;
}
