/** How a pulled project compares with the cloud as of the last sync. Pure. */
import { type GraphNode, ancestors, toGraph } from "../graph";
import type { BranchRef, RemoteRef } from "../types";

export type BranchSyncState =
  | "synced"
  /** Revisions made here that the cloud does not have. */
  | "ahead"
  /** The cloud has revisions this branch has not brought in. */
  | "behind"
  /** Both of the above. */
  | "diverged"
  /** A branch made here that the cloud does not have. */
  | "new";
export interface BranchStatus {
  name: string;
  state: BranchSyncState;
  ahead: number;
  behind: number;
}
export interface ProjectStatus {
  branches: BranchStatus[];
  /** Revisions on this device that are not in the cloud. */
  unpublishedRevisions: number;
  /** Branches on this device that are not in the cloud. */
  unpublishedBranches: number;
  /** Cloud revisions not yet part of any branch here. */
  incoming: number;
  /** Ids of the unpublished revisions, for marking them in the history graph. */
  unpublished: Set<string>;
}

export function projectStatus(
  refs: { branches: BranchRef[]; remotes: RemoteRef[] },
  commits: Iterable<GraphNode>,
): ProjectStatus {
  const graph = toGraph(commits);
  const remotes = new Map(refs.remotes.map((r) => [r.name, r]));
  const published = ancestors(
    graph,
    refs.remotes.map((r) => r.head),
  );
  const local = ancestors(
    graph,
    refs.branches.map((b) => b.head),
  );
  const count = (from: Set<string>, without: Set<string>) => {
    let n = 0;
    for (const oid of from) if (!without.has(oid) && graph.has(oid)) n++;
    return n;
  };
  const branches = refs.branches.map((branch): BranchStatus => {
    const remote = remotes.get(branch.name);
    const mine = ancestors(graph, [branch.head]);
    if (!remote)
      return {
        name: branch.name,
        state: "new",
        ahead: count(mine, published),
        behind: 0,
      };
    if (remote.head === branch.head)
      return { name: branch.name, state: "synced", ahead: 0, behind: 0 };
    const theirs = ancestors(graph, [remote.head]);
    const ahead = count(mine, theirs);
    const behind = count(theirs, mine);
    return {
      name: branch.name,
      state:
        ahead && behind
          ? "diverged"
          : ahead
            ? "ahead"
            : behind
              ? "behind"
              : "synced",
      ahead,
      behind,
    };
  });
  const unpublished = new Set<string>();
  for (const oid of local)
    if (!published.has(oid) && graph.has(oid)) unpublished.add(oid);
  return {
    branches,
    unpublishedRevisions: unpublished.size,
    unpublishedBranches: branches.filter((b) => b.state === "new").length,
    incoming: count(published, local),
    unpublished,
  };
}
