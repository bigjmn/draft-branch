/** Screenplay-aware three-way merge.
 *
 * Dependency-free on purpose: Cloud Functions and the browser compile this same
 * file (the app re-exports it from src/lib/projects/merge.ts). The server is
 * authoritative, but both sides must report identical conflict ids so that
 * resolutions chosen in the browser apply to the server's merge.
 *
 * Elements are matched by their stable ids. Content (type + text) and order are
 * merged independently:
 * - content: per element, the side that changed it wins; both changing it
 *   differently, or one deleting what the other edited, is a conflict.
 * - order: the id sequences are split at "anchor" elements that neither side
 *   moved or deleted. Between anchors, the side that rearranged/inserted wins;
 *   both doing so in the same gap is an order conflict. An element placed in two
 *   different gaps (both sides moved it) is a move conflict.
 */
export interface MergeBlock {
  id: string;
  type: string;
  text: string;
}
/** The title page travels with the screenplay and merges field by field. */
export interface MergeTitlePage {
  title: string;
  credit: string;
  authors: string;
  contact: string;
}
export const TITLE_PAGE_FIELDS = [
  "title",
  "credit",
  "authors",
  "contact",
] as const;
export type TitlePageField = (typeof TITLE_PAGE_FIELDS)[number];
/** Longest text each title page field accepts. */
export const TITLE_PAGE_LIMITS: Record<TitlePageField, number> = {
  title: 500,
  credit: 200,
  authors: 1000,
  contact: 2000,
};
export interface MergeDraft {
  title: string;
  blocks: MergeBlock[];
  titlePage?: MergeTitlePage;
}
export type MergeSide = "target" | "source";
export type Resolution = MergeSide | "both" | { text: string };
export type ConflictKind =
  "title" | "titlepage" | "content" | "delete" | "order" | "move";
export type ResolutionOption = MergeSide | "both" | "text";
export interface MergeConflict {
  /** Deterministic: "title", "titlepage:<field>", "block:<id>",
   * "order:<anchor id|start>", "move:<id>". */
  id: string;
  kind: ConflictKind;
  base?: MergeBlock | null;
  target?: MergeBlock | null;
  source?: MergeBlock | null;
  /** Order conflicts: what each side has in the contested gap. */
  targetBlocks?: MergeBlock[];
  sourceBlocks?: MergeBlock[];
  options: ResolutionOption[];
}
export interface MergeResult {
  /** The merged screenplay. Unresolved conflicts use the target's side. */
  draft: MergeDraft;
  conflicts: MergeConflict[];
  unresolved: string[];
}

export const MAX_RESOLUTION_TEXT = 100000;

const same = (a: MergeBlock, b: MergeBlock) =>
  a.type === b.type && a.text === b.text;
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);
const titleBlock = (text: string): MergeBlock => ({
  id: "title",
  type: "title",
  text,
});
const titlePageBlock = (
  field: TitlePageField,
  text: string | undefined,
): MergeBlock | null =>
  text === undefined ? null : { id: field, type: "titlepage", text };

export function resolutionAllowed(
  conflict: MergeConflict,
  value: Resolution,
): boolean {
  if (typeof value === "object")
    return (
      conflict.options.includes("text") &&
      typeof value?.text === "string" &&
      value.text.length <=
        (conflict.kind === "title"
          ? 200
          : conflict.kind === "titlepage"
            ? TITLE_PAGE_LIMITS[conflict.id.slice(10) as TitlePageField]
            : MAX_RESOLUTION_TEXT)
    );
  return conflict.options.includes(value);
}

/** Ids whose relative order `seq` kept from `base` (longest increasing run). */
function stableIds(base: string[], seq: string[]): Set<string> {
  const position = new Map(base.map((id, i) => [id, i]));
  const ids = seq.filter((id) => position.has(id));
  const values = ids.map((id) => position.get(id)!);
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < values[i]) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const result = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0;)
    (result.add(ids[i]), (i = previous[i]));
  return result;
}

type Origin = MergeSide | "both";

export function mergeDrafts(
  base: MergeDraft,
  target: MergeDraft,
  source: MergeDraft,
  resolutions: Record<string, Resolution> = {},
): MergeResult {
  const conflicts: MergeConflict[] = [];
  const unresolved: string[] = [];
  const decide = (conflict: MergeConflict): Resolution | undefined => {
    conflicts.push(conflict);
    const value = Object.prototype.hasOwnProperty.call(resolutions, conflict.id)
      ? resolutions[conflict.id]
      : undefined;
    if (value !== undefined && resolutionAllowed(conflict, value)) return value;
    unresolved.push(conflict.id);
    return undefined;
  };

  // Title.
  let title = target.title;
  if (target.title !== source.title && source.title !== base.title) {
    if (target.title === base.title) title = source.title;
    else {
      const choice = decide({
        id: "title",
        kind: "title",
        base: titleBlock(base.title),
        target: titleBlock(target.title),
        source: titleBlock(source.title),
        options: ["target", "source", "text"],
      });
      if (choice === "source") title = source.title;
      else if (typeof choice === "object") title = choice.text;
    }
  }

  // Title page, field by field. A draft without one (made before title pages
  // existed) takes the other side's.
  let titlePage: MergeTitlePage | undefined;
  if (target.titlePage || source.titlePage) {
    const page = {} as MergeTitlePage;
    for (const field of TITLE_PAGE_FIELDS) {
      const b = base.titlePage?.[field],
        t = target.titlePage?.[field],
        s = source.titlePage?.[field];
      let value = t;
      if (t !== s && s !== b) {
        if (t === b) value = s;
        else {
          const choice = decide({
            id: `titlepage:${field}`,
            kind: "titlepage",
            base: titlePageBlock(field, b),
            target: titlePageBlock(field, t),
            source: titlePageBlock(field, s),
            options: ["target", "source", "text"],
          });
          if (choice === "source") value = s;
          else if (typeof choice === "object") value = choice.text;
        }
      }
      page[field] = value ?? "";
    }
    titlePage = page;
  }

  // Content.
  const B = new Map(base.blocks.map((b) => [b.id, b]));
  const T = new Map(target.blocks.map((b) => [b.id, b]));
  const S = new Map(source.blocks.map((b) => [b.id, b]));
  const kept = new Map<string, MergeBlock>();
  const keptFrom = new Map<string, MergeSide>();
  const extra = new Map<string, MergeBlock>();
  const every = [...new Set([...T.keys(), ...S.keys(), ...B.keys()])];
  const taken = new Set(every);
  const keep = (block: MergeBlock, side: MergeSide) => {
    kept.set(block.id, block);
    keptFrom.set(block.id, T.has(block.id) ? "target" : side);
  };
  const freshId = (id: string) => {
    const stem = id.slice(0, 120);
    let n = 1,
      next = `${stem}-b`;
    while (taken.has(next)) next = `${stem}-b${++n}`;
    taken.add(next);
    return next;
  };
  for (const id of every) {
    const b = B.get(id),
      t = T.get(id),
      s = S.get(id);
    if (b) {
      if (!t && !s) continue;
      if (!t || !s) {
        const survivor = (t ?? s)!;
        const side: MergeSide = t ? "target" : "source";
        if (same(survivor, b)) continue; // deleted on one side, untouched on the other
        const choice = decide({
          id: `block:${id}`,
          kind: "delete",
          base: b,
          target: t ?? null,
          source: s ?? null,
          options: ["target", "source"],
        });
        if ((choice ?? "target") === side) keep(survivor, side);
        continue;
      }
      if (same(t, s) || same(s, b)) keep(t, "target");
      else if (same(t, b)) keep(s, "source");
      else resolveContent(b, t, s);
    } else if (t && s) {
      if (same(t, s)) keep(t, "target");
      else resolveContent(null, t, s);
    } else if (t) keep(t, "target");
    else if (s) keep(s, "source");
  }
  function resolveContent(b: MergeBlock | null, t: MergeBlock, s: MergeBlock) {
    const choice = decide({
      id: `block:${t.id}`,
      kind: "content",
      base: b,
      target: t,
      source: s,
      options: ["target", "source", "both", "text"],
    });
    if (choice === "source") keep(s, "source");
    else if (typeof choice === "object")
      keep({ ...t, text: choice.text }, "target");
    else {
      keep(t, "target");
      if (choice === "both") extra.set(t.id, { ...s, id: freshId(t.id) });
    }
  }

  // Order. Elements deleted by either side never anchor or contest a gap.
  const deleted = (id: string) => B.has(id) && (!T.has(id) || !S.has(id));
  const bs = base.blocks.map((b) => b.id).filter((id) => !deleted(id));
  const ts = target.blocks.map((b) => b.id).filter((id) => !deleted(id));
  const ss = source.blocks.map((b) => b.id).filter((id) => !deleted(id));
  const stableT = stableIds(bs, ts),
    stableS = stableIds(bs, ss);
  const anchors = bs.filter((id) => stableT.has(id) && stableS.has(id));
  const index = (ids: string[]) => new Map(ids.map((id, i) => [id, i]));
  const bI = index(bs),
    tI = index(ts),
    sI = index(ss);
  const order: { id: string; from: Origin }[] = [];
  const push = (ids: string[], from: Origin) =>
    ids.forEach((id) => order.push({ id, from }));
  let bi = 0,
    ti = 0,
    si = 0;
  for (let k = 0; k <= anchors.length; k++) {
    const anchor = anchors[k];
    const bEnd = anchor === undefined ? bs.length : bI.get(anchor)!;
    const tEnd = anchor === undefined ? ts.length : tI.get(anchor)!;
    const sEnd = anchor === undefined ? ss.length : sI.get(anchor)!;
    const bc = bs.slice(bi, bEnd),
      tc = ts.slice(ti, tEnd),
      sc = ss.slice(si, sEnd);
    if (sameIds(tc, sc)) push(tc, "both");
    else if (sameIds(tc, bc)) push(sc, "source");
    else if (sameIds(sc, bc)) push(tc, "target");
    else {
      const choice =
        decide({
          id: `order:${k === 0 ? "start" : anchors[k - 1]}`,
          kind: "order",
          targetBlocks: tc.map((id) => T.get(id)!),
          sourceBlocks: sc.map((id) => S.get(id)!),
          options: ["target", "source"],
        }) ?? "target";
      const [first, second]: [string[], string[]] =
        choice === "source" ? [sc, tc] : [tc, sc];
      const firstSide: MergeSide = choice === "source" ? "source" : "target";
      const secondSide: MergeSide =
        firstSide === "source" ? "target" : "source";
      const inFirst = new Set(first);
      const inSecond = new Set(second);
      first.forEach((id) =>
        order.push({ id, from: inSecond.has(id) ? "both" : firstSide }),
      );
      push(
        second.filter((id) => !inFirst.has(id)),
        secondSide,
      );
    }
    if (anchor !== undefined) order.push({ id: anchor, from: "both" });
    bi = bEnd + 1;
    ti = tEnd + 1;
    si = sEnd + 1;
  }

  // An element placed in two different gaps was moved by both sides.
  const occurrences = new Map<string, number[]>();
  order.forEach((entry, i) =>
    occurrences.set(entry.id, [...(occurrences.get(entry.id) ?? []), i]),
  );
  const dropped = new Set<number>();
  for (const [id, at] of occurrences) {
    if (at.length < 2) continue;
    const choice =
      decide({
        id: `move:${id}`,
        kind: "move",
        base: B.get(id) ?? null,
        target: T.get(id) ?? null,
        source: S.get(id) ?? null,
        options: ["target", "source"],
      }) ?? "target";
    const keepAt =
      at.find((i) => order[i].from === choice) ??
      at.find((i) => order[i].from === "both") ??
      at[0];
    at.filter((i) => i !== keepAt).forEach((i) => dropped.add(i));
  }

  const ids: string[] = [];
  const placed = new Set<string>();
  order.forEach((entry, i) => {
    if (dropped.has(i) || !kept.has(entry.id) || placed.has(entry.id)) return;
    ids.push(entry.id);
    placed.add(entry.id);
  });
  // Kept elements without a place (e.g. edited on one side, deleted on the
  // other, then kept) go after their nearest preceding neighbour on that side.
  for (const side of ["target", "source"] as const) {
    const seq = (side === "target" ? target : source).blocks.map((b) => b.id);
    seq.forEach((id, i) => {
      if (placed.has(id) || !kept.has(id) || keptFrom.get(id) !== side) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--)
        if (placed.has(seq[j])) {
          at = ids.indexOf(seq[j]) + 1;
          break;
        }
      ids.splice(at, 0, id);
      placed.add(id);
    });
  }

  const blocks: MergeBlock[] = [];
  for (const id of ids) {
    blocks.push(kept.get(id)!);
    const copy = extra.get(id);
    if (copy) blocks.push(copy);
  }
  if (!blocks.length)
    blocks.push({ id: freshId("merged-scene"), type: "scene", text: "" });
  return {
    draft: { title, blocks, ...(titlePage ? { titlePage } : {}) },
    conflicts,
    unresolved,
  };
}
