/** Commit graph layout for the version-control panel (GitComet-style lanes). */
export interface GraphCommit {
  oid: string;
  parent: string[];
  timestamp: number;
}
export type Segment =
  /** Lane j continues straight through this row. */
  | { kind: "pass"; lane: number; color: number }
  /** Lane `from` enters this row's commit from above. */
  | { kind: "in"; from: number; to: number; color: number }
  /** This row's commit continues down into lane `to`. */
  | { kind: "out"; from: number; to: number; color: number };
export interface GraphRow {
  oid: string;
  lane: number;
  color: number;
  merge: boolean;
  segments: Segment[];
}
export const LANE_COLORS = 6;

/** Newest first, but never a parent before any of its loaded children. */
export function orderCommits<T extends GraphCommit>(commits: T[]): T[] {
  const byId = new Map(commits.map((c) => [c.oid, c]));
  const children = new Map<string, number>();
  for (const c of commits)
    for (const p of c.parent)
      if (byId.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const newer = (a: T, b: T) =>
    b.timestamp - a.timestamp || (a.oid < b.oid ? -1 : 1);
  const ready = commits.filter((c) => !children.get(c.oid)).sort(newer);
  const result: T[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    result.push(next);
    for (const p of next.parent) {
      if (!byId.has(p)) continue;
      const left = children.get(p)! - 1;
      children.set(p, left);
      if (left === 0) {
        const parent = byId.get(p)!;
        const at = ready.findIndex((c) => newer(parent, c) < 0);
        ready.splice(at === -1 ? ready.length : at, 0, parent);
      }
    }
  }
  return result;
}

/** Assign lanes like `git log --graph`: each lane waits for one commit id. */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const free = () => {
    const at = lanes.indexOf(null);
    return at === -1 ? lanes.length : at;
  };
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const segments: Segment[] = [];
    let lane = lanes.indexOf(commit.oid);
    const tip = lane === -1; // Nothing above a branch tip in its own lane.
    if (tip) {
      lane = free();
      lanes[lane] = commit.oid;
      colors[lane] = nextColor++ % LANE_COLORS;
    }
    lanes.forEach((waiting, j) => {
      if (waiting === null) return;
      if (waiting === commit.oid) {
        if (!(tip && j === lane))
          segments.push({ kind: "in", from: j, to: lane, color: colors[j] });
        if (j !== lane) lanes[j] = null;
      } else segments.push({ kind: "pass", lane: j, color: colors[j] });
    });
    const [first, ...rest] = commit.parent;
    if (first === undefined) lanes[lane] = null;
    else {
      const existing = lanes.indexOf(first);
      if (existing !== -1 && existing !== lane) {
        lanes[lane] = null;
        segments.push({
          kind: "out",
          from: lane,
          to: existing,
          color: colors[existing],
        });
      } else {
        lanes[lane] = first;
        segments.push({
          kind: "out",
          from: lane,
          to: lane,
          color: colors[lane],
        });
      }
    }
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = free();
        lanes[k] = p;
        colors[k] = nextColor++ % LANE_COLORS;
      }
      segments.push({ kind: "out", from: lane, to: k, color: colors[k] });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({
      oid: commit.oid,
      lane,
      color: colors[lane],
      merge: commit.parent.length > 1,
      segments,
    });
  }
  return rows;
}
export const graphWidth = (rows: GraphRow[]) =>
  rows.reduce(
    (max, row) =>
      Math.max(
        max,
        row.lane + 1,
        ...row.segments.map((s) =>
          s.kind === "pass" ? s.lane + 1 : Math.max(s.from, s.to) + 1,
        ),
      ),
    1,
  );

/** Commits reachable from `head` within the loaded window. */
export function reachable(
  byId: Map<string, GraphCommit>,
  head: string | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack = head ? [head] : [];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = byId.get(oid);
    if (commit) stack.push(...commit.parent);
  }
  return seen;
}
/** Ahead/behind counts of `head` relative to `base`, like Git's ↑/↓. */
export function aheadBehind(
  byId: Map<string, GraphCommit>,
  head: string,
  base: string,
): { ahead: number; behind: number } {
  const mine = reachable(byId, head),
    theirs = reachable(byId, base);
  let ahead = 0,
    behind = 0;
  for (const oid of mine) if (!theirs.has(oid) && byId.has(oid)) ahead++;
  for (const oid of theirs) if (!mine.has(oid) && byId.has(oid)) behind++;
  return { ahead, behind };
}
