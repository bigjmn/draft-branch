/** Commit-graph queries used by the local repository and by sync. Pure functions. */
export interface GraphNode {
  oid: string;
  parent: string[];
  timestamp: number;
}
export type Graph = Map<string, GraphNode>;

export function toGraph<T extends GraphNode>(
  commits: Iterable<T>,
): Map<string, T> {
  const graph = new Map<string, T>();
  for (const commit of commits) graph.set(commit.oid, commit);
  return graph;
}

/** Every commit reachable from `starts`, including the starts themselves. */
export function ancestors(graph: Graph, starts: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...(graph.get(oid)?.parent ?? []));
  }
  return seen;
}

/** True when `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(
  graph: Graph,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...(graph.get(oid)?.parent ?? []));
  }
  return false;
}

/** Best common ancestor: a common ancestor that no other common ancestor
 * descends from; the latest wins in criss-cross histories. Same rule as
 * ProjectService.mergeBase in the backend, so local and cloud merges agree. */
export function mergeBase(graph: Graph, a: string, b: string): string | null {
  const fromB = ancestors(graph, [b]);
  const common = [...ancestors(graph, [a])].filter((oid) => fromB.has(oid));
  if (!common.length) return null;
  const dominated = ancestors(
    graph,
    common.flatMap((oid) => graph.get(oid)?.parent ?? []),
  );
  const best = common.filter((oid) => !dominated.has(oid));
  best.sort(
    (x, y) =>
      (graph.get(y)?.timestamp ?? 0) - (graph.get(x)?.timestamp ?? 0) ||
      (x < y ? -1 : 1),
  );
  return best[0] ?? null;
}

/** The commits on `head`'s first-parent line that are not in `stop`, oldest
 * first, together with the commit they sit on (null if the line has no end in
 * `stop`, i.e. the history is entirely outside it). */
export function firstParentChain(
  graph: Graph,
  head: string,
  stop: ReadonlySet<string>,
): { base: string | null; chain: string[] } {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = head;
  while (cursor !== undefined && !stop.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = graph.get(cursor)?.parent[0];
  }
  chain.reverse();
  return {
    base: cursor !== undefined && stop.has(cursor) ? cursor : null,
    chain,
  };
}

/** Parents before children. Commits whose parents are outside `commits` come first. */
export function topological<T extends GraphNode>(commits: T[]): T[] {
  const byId = new Map(commits.map((c) => [c.oid, c]));
  const done = new Set<string>();
  const result: T[] = [];
  // Iterative depth-first walk; histories can be thousands of commits long.
  for (const start of commits) {
    if (done.has(start.oid)) continue;
    const stack: { commit: T; next: number }[] = [{ commit: start, next: 0 }];
    const open = new Set<string>([start.oid]);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const parentId = frame.commit.parent[frame.next++];
      if (parentId === undefined) {
        stack.pop();
        open.delete(frame.commit.oid);
        if (!done.has(frame.commit.oid)) {
          done.add(frame.commit.oid);
          result.push(frame.commit);
        }
        continue;
      }
      const parent = byId.get(parentId);
      if (parent && !done.has(parentId) && !open.has(parentId)) {
        open.add(parentId);
        stack.push({ commit: parent, next: 0 });
      }
    }
  }
  return result;
}
