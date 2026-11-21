import { sameScreenplayElement } from "./element-equality";
import type { Draft, ScriptBlock } from "@/lib/editor/types";
export interface DiffRow {
  kind: "context" | "added" | "removed";
  block: ScriptBlock;
  oldNumber?: number;
  newNumber?: number;
  title?: boolean;
  /** Original text when a context row differs only in display-equivalent casing. */
  oldBlock?: ScriptBlock;
}
/** Align stable IDs with an O(n log n) longest increasing subsequence.
 * Moved elements appear once at their old position and once at their new position.
 * Context rows retain oldBlock when raw text differs but rendering is equivalent. */
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
      rows.push({ kind: "removed", block: a, oldNumber: i + 1 });
      rows.push({ kind: "added", block: b, newNumber: j + 1 });
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
