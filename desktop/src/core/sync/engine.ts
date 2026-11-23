/** Two-way sync between a project on this device and DraftBranch cloud.
 *
 * The cloud only accepts revisions through its own API: one commit at a time on
 * top of a branch's current head, made from the account's working draft. So
 * sync works like this:
 *
 *  1. Fetch. Rebuild every new cloud revision as a Git commit here (same bytes,
 *     same id) and remember where each cloud branch is.
 *  2. Reconcile. A branch with nothing new of its own fast-forwards. A branch
 *     whose offline revisions and cloud revisions both moved is replayed onto
 *     the cloud head, one revision at a time, asking the writer about real
 *     conflicts.
 *  3. Bring in the account's cloud working draft, merging it with writing done
 *     here when both changed.
 *  4. Publish. Each offline revision is saved as the cloud working draft and
 *     committed there; the device then adopts the resulting cloud revision in
 *     place of its own, so both sides hold identical history.
 *  5. Upload the working draft so the web app sees the latest writing.
 *
 * Every step leaves the device consistent, and a later run picks up wherever an
 * interrupted one stopped, so nothing here needs to be all-or-nothing.
 */
import {
  type Resolution,
  mergeDrafts,
} from "../../../../functions/src/projects/merge";
import {
  ancestors,
  firstParentChain,
  isAncestor,
  toGraph,
  topological,
} from "../graph";
import { type Snapshot, parseSnapshot, sameSnapshot } from "../snapshot";
import type {
  BranchRef,
  CommitInfo,
  ProjectApi,
  ProjectState,
  RemoteRef,
  Role,
  SyncState,
} from "../types";
import { type CloudApi, type CloudCommit, CloudError } from "./cloud";

export interface ConflictRequest {
  /** "revision": replaying an offline revision onto newer cloud revisions.
   *  "draft": the working draft changed both here and in the cloud. */
  kind: "revision" | "draft";
  branch: string;
  title: string;
  description: string;
  base: Snapshot;
  /** The side that is kept when a conflict is left undecided. */
  target: Snapshot;
  source: Snapshot;
  labels: { target: string; source: string };
}
export interface SyncHooks {
  /** Ask the writer to settle overlapping edits. Return null to leave the
   * branch as it is; sync reports it under `attention` and moves on. */
  resolve?(
    request: ConflictRequest,
  ): Promise<Record<string, Resolution> | null>;
  /** A branch made offline starts from a revision that is no longer the head
   * of any cloud branch, so the cloud cannot start it there. Return true to
   * move its revisions onto `onto`'s latest cloud revision and publish it. */
  restart?(question: { branch: string; onto: string }): Promise<boolean>;
  progress?(message: string): void;
}
export interface SyncOptions {
  /** A branch open in an editor. Sync will not move its head or rewrite its
   * draft, because the editor holds both in memory. */
  hold?: string | null | (() => string | null);
  /** Branches whose cloud working draft is checked even with no draft here. */
  focus?: string[];
  /** Check the cloud working draft of every branch (a first pull). */
  allDrafts?: boolean;
  signal?: AbortSignal;
  hooks?: SyncHooks;
  requestId?: () => string;
  now?: () => number;
}
export type Attention =
  /** The open branch has cloud revisions waiting. */
  | { kind: "updates"; branch: string; count: number }
  /** Offline revisions and cloud revisions both moved; needs a replay. */
  | { kind: "diverged"; branch: string }
  /** The open branch has revisions waiting to be published. */
  | { kind: "pending"; branch: string; count: number }
  /** The working draft changed here and in the cloud. */
  | { kind: "draft"; branch: string }
  /** A branch made offline starts from a revision that is no longer a head. */
  | { kind: "stale-branch"; branch: string }
  | { kind: "forbidden"; branch: string; message: string }
  | { kind: "failed"; branch?: string; message: string };
export interface SyncReport {
  /** Every phase ran. Individual branches can still be listed in `attention`. */
  ok: boolean;
  offline: boolean;
  aborted: boolean;
  access: "ok" | "revoked";
  error?: string;
  /** Cloud revisions new to this device. */
  fetched: number;
  createdBranches: string[];
  fastForwarded: string[];
  replayed: string[];
  published: Record<string, number>;
  publishedBranches: string[];
  draftsPulled: string[];
  draftsMerged: string[];
  draftsPushed: string[];
  attention: Attention[];
  /** Local refs or drafts changed; an open editor should reload. */
  changedLocal: boolean;
  /** Revisions whose text is still to be downloaded for offline reading. */
  contentPending: number;
}

class Aborted extends Error {}
/** Thrown by a ProjectApi to stop a sync cleanly, e.g. because the branch it
 * was about to move has just been opened in an editor. */
export class SyncInterrupted extends Error {
  constructor(message = "Sync was interrupted.") {
    super(message);
    this.name = "SyncInterrupted";
  }
}
const MAX_ROUNDS = 2000;

export function syncProject(
  cloud: CloudApi,
  local: ProjectApi,
  options: SyncOptions = {},
): Promise<SyncReport> {
  return new SyncRun(cloud, local, options).execute();
}

class SyncRun {
  private readonly report: SyncReport = {
    ok: false,
    offline: false,
    aborted: false,
    access: "ok",
    fetched: 0,
    createdBranches: [],
    fastForwarded: [],
    replayed: [],
    published: {},
    publishedBranches: [],
    draftsPulled: [],
    draftsMerged: [],
    draftsPushed: [],
    attention: [],
    changedLocal: false,
    contentPending: 0,
  };
  private state!: ProjectState;
  private sync!: SyncState;
  private graph = new Map<string, CommitInfo>();
  private cloudOf = new Map<string, string>();
  private pid = "";
  private role: Role = "reviewer";
  /** Version of the account's cloud working draft, per branch. */
  private readonly versions = new Map<string, number>();
  /** Blob id of the text the cloud working draft holds, per branch. */
  private readonly cloudText = new Map<string, string>();
  /** Branches whose cloud draft has writing this device has not taken in;
   * nothing may be uploaded over it. */
  private readonly blocked = new Set<string>();
  private readonly failedBranches = new Set<string>();
  private readonly declined = new Set<string>();

  constructor(
    private readonly cloud: CloudApi,
    private readonly local: ProjectApi,
    private readonly options: SyncOptions,
  ) {}

  async execute(): Promise<SyncReport> {
    try {
      await this.refresh();
      const link = this.state.meta.cloud;
      if (!link) throw new Error("This project is not linked to the cloud.");
      if (link.uid !== this.cloud.uid)
        throw new Error("This project belongs to a different account.");
      this.pid = this.state.meta.id;
      if (!(await this.checkAccess())) return this.report;
      await this.fetch();
      await this.reconcile();
      await this.pullDrafts();
      await this.publish();
      await this.pushDrafts();
      await this.finish();
      this.report.ok = true;
    } catch (error) {
      if (error instanceof Aborted || error instanceof SyncInterrupted)
        this.report.aborted = true;
      else if (error instanceof CloudError && error.kind === "offline")
        this.report.offline = true;
      else
        this.report.error =
          error instanceof Error ? error.message : String(error);
    }
    return this.report;
  }

  // ------------------------------------------------------------- helpers

  private check() {
    if (this.options.signal?.aborted) throw new Aborted();
  }
  private say(message: string) {
    this.options.hooks?.progress?.(message);
  }
  private held(branch: string): boolean {
    const hold = this.options.hold;
    return (typeof hold === "function" ? hold() : hold) === branch;
  }
  private requestId(): string {
    return this.options.requestId?.() ?? crypto.randomUUID();
  }
  private async refresh() {
    const [state, commits, sync] = await Promise.all([
      this.local.state(),
      this.local.commits(),
      this.local.syncState(),
    ]);
    this.state = state;
    this.sync = sync;
    this.graph = toGraph(commits);
    this.cloudOf = new Map(
      Object.entries(sync.oidMap).map(([cloud, local]) => [local, cloud]),
    );
  }
  private toLocal(cloudOid: string) {
    return this.sync.oidMap[cloudOid] ?? cloudOid;
  }
  private toCloud(localOid: string) {
    return this.cloudOf.get(localOid) ?? localOid;
  }
  private remote(name: string): RemoteRef | undefined {
    return this.state.remotes.find((r) => r.name === name);
  }
  private branch(name: string): BranchRef | undefined {
    return this.state.branches.find((b) => b.name === name);
  }
  private published(): Set<string> {
    return ancestors(
      this.graph,
      this.state.remotes.map((r) => r.head),
    );
  }
  private attention(item: Attention) {
    this.report.attention.push(item);
  }
  private async moved(update: Parameters<ProjectApi["updateRefs"]>[0]) {
    await this.local.updateRefs(update);
    this.report.changedLocal = true;
    await this.refresh();
  }
  /** Download the screenplay text of these revisions if it is not here yet. */
  private async ensureContent(oids: Iterable<string>, label?: string) {
    const jobs = new Map<string, string>();
    for (const oid of oids) {
      const commit = this.graph.get(oid);
      if (commit && !commit.hasContent && !jobs.has(commit.blob))
        jobs.set(commit.blob, oid);
    }
    if (!jobs.size) return;
    const queue = [...jobs.entries()];
    const total = queue.length;
    let done = 0;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        this.check();
        const [blob, oid] = job;
        const snapshot = await this.cloud.readRevision(
          this.pid,
          this.toCloud(oid),
        );
        await this.local.writeSnapshot(snapshot, blob);
        done++;
        if (label) this.say(`${label} (${done} of ${total})`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
    await this.refresh();
  }
  private async read(oid: string): Promise<Snapshot> {
    await this.ensureContent([oid]);
    return this.local.readSnapshot(oid);
  }

  // -------------------------------------------------------------- phases

  private async checkAccess(): Promise<boolean> {
    this.say("Checking access");
    const meta = this.state.meta;
    const access = await this.cloud.access(this.pid);
    if (!access) {
      await this.local.setMeta({ cloud: { access: "revoked" } });
      this.report.access = "revoked";
      return false;
    }
    this.role = access.role;
    const pending = meta.cloud!.pendingTitle;
    if (pending && access.role === "owner") {
      if (pending !== access.title)
        await this.cloud.renameProject(this.pid, pending);
      await this.local.setMeta({
        title: pending,
        cloud: { role: access.role, access: "ok", pendingTitle: "" },
      });
    } else
      await this.local.setMeta({
        ...(meta.title !== access.title ? { title: access.title } : {}),
        cloud: { role: access.role, access: "ok", pendingTitle: "" },
      });
    return true;
  }

  private async fetch() {
    this.check();
    this.say("Checking for updates");
    const branches = await this.cloud.branches(this.pid);
    if (!branches.length)
      throw new Error("This cloud project has no branches.");
    const known = (cloudOid: string) => this.graph.has(this.toLocal(cloudOid));
    if (branches.some((b) => !known(b.head))) {
      const all = await this.cloud.commits(this.pid);
      const missing = all.filter((c) => !known(c.oid));
      const names = missing.some((c) => !c.authorName)
        ? await this.cloud.memberNames(this.pid)
        : {};
      const ordered = topological(missing);
      this.say(
        `Bringing in ${ordered.length} revision${ordered.length === 1 ? "" : "s"}`,
      );
      for (let at = 0; at < ordered.length; at += 250) {
        this.check();
        const results = await this.local.importCommits(
          ordered.slice(at, at + 250).map((c) => this.importable(c, names)),
        );
        this.report.fetched += results.length;
      }
      await this.refresh();
    }
    const remotes = branches.map((b) => ({
      name: b.name,
      head: this.toLocal(b.head),
      cloudHead: b.head,
      protected: b.protected,
    }));
    // updateRefs refuses a head it does not have, which is what we want if the
    // cloud names a revision that could not be fetched.
    await this.local.updateRefs({ remotes });
    await this.refresh();
    await this.ensureContent(
      remotes.map((r) => r.head),
      "Downloading the latest revisions",
    );
  }
  private importable(commit: CloudCommit, names: Record<string, string[]>) {
    return {
      oid: commit.oid,
      tree: commit.tree,
      blob: commit.blob,
      parent: commit.parent,
      message: commit.message,
      actorUid: commit.actorUid,
      timestamp: commit.timestamp,
      authorNames: commit.authorName
        ? [commit.authorName]
        : [...new Set([...(names[commit.actorUid] ?? []), "Writer"])],
      ...(commit.merge ? { merge: commit.merge } : {}),
    };
  }

  private async reconcile() {
    for (const name of this.state.remotes.map((r) => r.name)) {
      this.check();
      let remote = this.remote(name)!;
      let branch = this.branch(name);
      if (!branch) {
        await this.moved({
          branches: {
            [name]: {
              head: remote.head,
              expected: null,
              protected: remote.protected,
            },
          },
        });
        this.report.createdBranches.push(name);
        continue;
      }
      if (branch.protected !== remote.protected) {
        await this.local.updateRefs({
          branches: {
            [name]: {
              head: branch.head,
              expected: branch.head,
              protected: remote.protected,
            },
          },
        });
        await this.refresh();
        branch = this.branch(name)!;
      }
      if (branch.head === remote.head) continue;
      if (!this.held(name) && (await this.adopt(name))) {
        branch = this.branch(name)!;
        remote = this.remote(name)!;
        if (branch.head === remote.head) continue;
      }
      if (isAncestor(this.graph, branch.head, remote.head)) {
        if (this.held(name)) {
          this.attention({
            kind: "updates",
            branch: name,
            count: this.between(branch.head, remote.head),
          });
          continue;
        }
        await this.moved({
          branches: { [name]: { head: remote.head, expected: branch.head } },
        });
        this.report.fastForwarded.push(name);
      } else if (!isAncestor(this.graph, remote.head, branch.head)) {
        if (this.held(name) || !(await this.replay(name, remote.head)))
          this.attention({ kind: "diverged", branch: name });
        else this.report.replayed.push(name);
      }
    }
  }
  /** Revisions reachable from `to` that are not reachable from `from`. */
  private between(from: string, to: string): number {
    const have = ancestors(this.graph, [from]);
    let n = 0;
    for (const oid of ancestors(this.graph, [to])) if (!have.has(oid)) n++;
    return n;
  }

  /** If the first unpublished revisions of a branch already exist in the cloud
   * (the same text and message on the same parent), stand on those instead.
   * This is how a published revision replaces its offline original, and how a
   * sync that was cut off after the cloud accepted a revision recovers. */
  private async adopt(name: string): Promise<boolean> {
    const branch = this.branch(name);
    if (!branch) return false;
    const published = this.published();
    const { base, chain } = firstParentChain(
      this.graph,
      branch.head,
      published,
    );
    if (base === null || !chain.length) return false;
    const remote = this.remote(name);
    // A tracked branch only adopts revisions on its own cloud line.
    const eligible = remote ? ancestors(this.graph, [remote.head]) : published;
    const children = new Map<string, CommitInfo[]>();
    for (const oid of eligible) {
      const commit = this.graph.get(oid);
      if (commit?.parent.length === 1)
        children.set(commit.parent[0], [
          ...(children.get(commit.parent[0]) ?? []),
          commit,
        ]);
    }
    const moves: Record<string, string> = {};
    let cursor = base;
    let taken = 0;
    for (; taken < chain.length; taken++) {
      const mine = this.graph.get(chain[taken])!;
      if (mine.parent.length !== 1) break;
      const twin = children
        .get(cursor)
        ?.find((c) => c.blob === mine.blob && c.message === mine.message);
      if (!twin) break;
      moves[mine.oid] = twin.oid;
      cursor = twin.oid;
    }
    if (!taken) return false;
    // Put what is still unpublished on top of the adopted revisions.
    for (const oid of chain.slice(taken)) {
      const mine = this.graph.get(oid)!;
      const copy = await this.local.createCommit({
        parent: [cursor, ...mine.parent.slice(1)],
        treeOf: mine.oid,
        message: mine.message,
        authorName: mine.authorName,
        authorKey: mine.authorKey,
        timestamp: mine.timestamp,
      });
      moves[mine.oid] = copy.oid;
      cursor = copy.oid;
    }
    await this.moved({
      branches: {
        [name]: { head: cursor, expected: branch.head, rebaseDraft: moves },
      },
    });
    return true;
  }

  /** Replay this branch's unpublished revisions on top of `onto`. */
  private async replay(name: string, onto: string): Promise<boolean> {
    const branch = this.branch(name)!;
    const { base, chain } = firstParentChain(
      this.graph,
      branch.head,
      this.published(),
    );
    if (base === null) return false;
    this.say(`Bringing cloud revisions into ${name}`);
    const sameText: Record<string, string> = {};
    let tip = onto;
    for (const oid of chain) {
      this.check();
      const mine = this.graph.get(oid)!;
      if (mine.parent.length !== 1) return false;
      const before = await this.read(mine.parent[0]);
      const theirs = await this.read(tip);
      const text = await this.read(oid);
      const result = await this.combine({
        kind: "revision",
        branch: name,
        title: `Combine “${mine.message.split("\n")[0]}” with newer cloud revisions`,
        description: `${name} changed in the cloud while this revision was waiting to be published. Both sets of changes are kept; choose what to do where they overlap.`,
        base: before,
        target: theirs,
        source: text,
        labels: { target: `Cloud ${name}`, source: "Your revision" },
      });
      if (!result) return false;
      if (sameSnapshot(result, theirs)) continue; // Nothing of this revision is left to add.
      const copy = await this.local.createCommit({
        parent: [tip],
        snapshot: result,
        message: mine.message,
        authorName: mine.authorName,
        authorKey: mine.authorKey,
        timestamp: mine.timestamp,
      });
      if (sameSnapshot(result, text)) sameText[oid] = copy.oid;
      tip = copy.oid;
    }
    // A draft with unsaved writing keeps its old base on purpose: the editor's
    // "Bring in updates" then merges the cloud changes into it. Only drafts
    // sitting on a revision whose text did not change move with it.
    await this.moved({
      branches: {
        [name]: { head: tip, expected: branch.head, rebaseDraft: sameText },
      },
    });
    return true;
  }

  /** Three-way merge, asking the writer when edits overlap. Null if undecided. */
  private async combine(request: ConflictRequest): Promise<Snapshot | null> {
    if (sameSnapshot(request.base, request.target)) return request.source;
    if (sameSnapshot(request.base, request.source)) return request.target;
    let merged = mergeDrafts(request.base, request.target, request.source);
    if (merged.unresolved.length) {
      const resolutions =
        (await this.options.hooks?.resolve?.(request)) ?? null;
      if (!resolutions) return null;
      merged = mergeDrafts(
        request.base,
        request.target,
        request.source,
        resolutions,
      );
      if (merged.unresolved.length) return null;
    }
    return parseSnapshot({ ...merged.draft, schemaVersion: 1 });
  }

  private async blobOf(snapshot: unknown): Promise<string> {
    return (await this.local.writeSnapshot(snapshot)).blob;
  }
  private unpublishedOn(name: string): string[] {
    const branch = this.branch(name);
    return branch
      ? firstParentChain(this.graph, branch.head, this.published()).chain
      : [];
  }

  private async pullDrafts() {
    if (this.role === "reviewer") return;
    const wanted = new Set<string>([
      ...this.state.drafts.map((d) => d.branch),
      ...(this.options.focus ?? []),
      ...(this.options.allDrafts ? this.state.branches.map((b) => b.name) : []),
      ...this.state.branches
        .filter((b) => this.unpublishedOn(b.name).length)
        .map((b) => b.name),
    ]);
    for (const name of wanted) {
      this.check();
      const remote = this.remote(name);
      if (!remote || !this.branch(name)) continue;
      this.say(`Checking the working draft on ${name}`);
      const cloud = await this.cloud.loadDraft(this.pid, name);
      if (cloud.head !== remote.cloudHead) {
        // The branch moved after we fetched it; the next sync sees the whole picture.
        this.blocked.add(name);
        continue;
      }
      const cloudDraft = parseSnapshot(cloud.draft);
      const cloudBlob = await this.blobOf(cloudDraft);
      this.versions.set(name, cloud.version);
      this.cloudText.set(name, cloudBlob);
      const cloudBase = this.graph.get(this.toLocal(cloud.baseCommit));
      const previous = this.sync.drafts[name];
      // Nothing in the cloud draft beyond a revision, or nothing we have not seen.
      if (cloudBase?.blob === cloudBlob || previous?.syncedBlob === cloudBlob)
        continue;
      const mine = await this.local.loadDraft(name);
      const myBlob = await this.blobOf(mine.draft);
      if (myBlob === cloudBlob) {
        await this.local.setDraftSync(name, {
          cloudVersion: cloud.version,
          syncedBlob: cloudBlob,
        });
        continue;
      }
      if (this.held(name)) {
        this.attention({ kind: "draft", branch: name });
        this.blocked.add(name);
        continue;
      }
      const untouched =
        !this.unpublishedOn(name).length &&
        (mine.clean || previous?.syncedBlob === myBlob);
      if (untouched) {
        const saved = await this.local.setDraft({
          branch: name,
          expectedVersion: mine.version,
          draft: cloudDraft,
          baseCommit: cloudBase ? cloudBase.oid : remote.head,
        });
        if (saved.status !== "accepted") {
          this.attention({ kind: "draft", branch: name });
          this.blocked.add(name);
          continue;
        }
        await this.local.setDraftSync(name, {
          cloudVersion: cloud.version,
          syncedBlob: cloudBlob,
        });
        this.report.draftsPulled.push(name);
        this.report.changedLocal = true;
        continue;
      }
      const base = previous
        ? await this.local.readBlob(previous.syncedBlob)
        : await this.read(cloudBase ? cloudBase.oid : remote.head);
      const result = await this.combine({
        kind: "draft",
        branch: name,
        title: `Combine writing on ${name} from this device and the cloud`,
        description:
          "This working draft changed here and in DraftBranch on the web. Both are kept; choose what to do where they overlap.",
        base,
        target: mine.draft,
        source: cloudDraft,
        labels: { target: "This device", source: "Cloud draft" },
      });
      const saved = result
        ? await this.local.setDraft({
            branch: name,
            expectedVersion: mine.version,
            draft: result,
          })
        : null;
      if (saved?.status !== "accepted") {
        this.attention({ kind: "draft", branch: name });
        this.blocked.add(name);
        continue;
      }
      this.report.draftsMerged.push(name);
      this.report.changedLocal = true;
    }
    await this.refresh();
  }

  private async publish() {
    if (this.role === "reviewer") return;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      this.check();
      for (const branch of [...this.state.branches])
        if (!this.held(branch.name)) await this.adopt(branch.name);
      let progressed = false;
      // Whether a new branch can be started is decided afresh each round.
      this.report.attention = this.report.attention.filter(
        (item) => item.kind !== "stale-branch",
      );

      // Branches made here. The cloud can only start a branch at another
      // branch's current head, so these go first, before that head moves.
      const chains = new Map(
        this.state.branches.map((b) => [b.name, this.unpublishedOn(b.name)]),
      );
      for (const branch of [...this.state.branches]) {
        if (this.remote(branch.name) || this.failedBranches.has(branch.name))
          continue;
        const { base, chain } = firstParentChain(
          this.graph,
          branch.head,
          this.published(),
        );
        if (base === null) continue;
        // Revisions shared with the branch this one was made from are published
        // there first; this branch then starts from the published revision.
        if (
          chain.length &&
          this.state.branches.some(
            (other) =>
              other.name !== branch.name &&
              this.senior(other, branch) &&
              chains.get(other.name)!.includes(chain[0]),
          )
        )
          continue;
        const source =
          this.state.remotes.find(
            (r) => r.name === branch.source && r.head === base,
          ) ?? this.state.remotes.find((r) => r.head === base);
        if (!source) {
          if (await this.restart(branch)) progressed = true;
          else this.attention({ kind: "stale-branch", branch: branch.name });
          continue;
        }
        this.say(`Publishing branch ${branch.name}`);
        const cloudHead = this.toCloud(base);
        try {
          await this.cloud.createBranch({
            projectId: this.pid,
            name: branch.name,
            sourceBranch: source.name,
            expectedHead: cloudHead,
            requestId: this.requestId(),
          });
        } catch (error) {
          this.branchFailed(branch.name, error);
          continue;
        }
        await this.local.updateRefs({
          remotes: [
            ...this.state.remotes,
            { name: branch.name, head: base, cloudHead, protected: false },
          ],
        });
        await this.refresh();
        this.versions.set(branch.name, 0);
        this.report.publishedBranches.push(branch.name);
        progressed = true;
      }

      // One revision per branch per round, oldest first.
      for (const branch of [...this.state.branches]) {
        const name = branch.name;
        const remote = this.remote(name);
        const local = this.branch(name);
        if (!remote || !local || local.head === remote.head) continue;
        if (this.blocked.has(name) || this.failedBranches.has(name)) continue;
        if (!isAncestor(this.graph, remote.head, local.head)) continue;
        const { base, chain } = firstParentChain(
          this.graph,
          local.head,
          this.published(),
        );
        if (!chain.length || base !== remote.head) continue;
        if (this.held(name)) {
          this.failedBranches.add(name);
          this.attention({
            kind: "pending",
            branch: name,
            count: chain.length,
          });
          continue;
        }
        if (remote.protected && this.role !== "owner") {
          this.failedBranches.add(name);
          this.attention({
            kind: "forbidden",
            branch: name,
            message: `Only the owner can publish to ${name}. Your revisions stay on this device.`,
          });
          continue;
        }
        try {
          if (await this.publishOne(name, remote, chain[0])) progressed = true;
          else this.failedBranches.add(name);
        } catch (error) {
          this.branchFailed(name, error);
        }
      }
      if (!progressed) return;
    }
  }
  /** With the writer's agreement, move an unpublishable new branch onto the
   * latest cloud revision of the branch it came from. Asked once per sync. */
  private async restart(branch: BranchRef): Promise<boolean> {
    if (this.declined.has(branch.name) || this.held(branch.name)) return false;
    const onto =
      this.remote(branch.source ?? "") ??
      this.remote(this.state.meta.defaultBranch);
    const ask = this.options.hooks?.restart;
    if (!onto || !ask) return false;
    if (
      !(await ask({ branch: branch.name, onto: onto.name })) ||
      !(await this.replay(branch.name, onto.head))
    ) {
      this.declined.add(branch.name);
      return false;
    }
    this.report.replayed.push(branch.name);
    return true;
  }
  /** Whether `other` is the branch that publishes revisions it shares with `branch`. */
  private senior(other: BranchRef, branch: BranchRef): boolean {
    if (this.remote(other.name) || other.name === branch.source) return true;
    return (
      other.source !== branch.name &&
      branch.source !== other.name &&
      other.name < branch.name
    );
  }
  /** One branch failing must not stop the others; losing the connection does. */
  private branchFailed(name: string, error: unknown) {
    if (error instanceof Aborted || error instanceof SyncInterrupted)
      throw error;
    if (error instanceof CloudError && error.kind === "offline") throw error;
    this.failedBranches.add(name);
    this.attention({
      kind: "failed",
      branch: name,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async publishOne(
    name: string,
    remote: RemoteRef,
    oid: string,
  ): Promise<boolean> {
    const mine = this.graph.get(oid)!;
    const fail = (message: string) => {
      this.attention({ kind: "failed", branch: name, message });
      return false;
    };
    if (!this.versions.has(name)) {
      const cloud = await this.cloud.loadDraft(this.pid, name);
      if (cloud.head !== remote.cloudHead)
        return fail(`${name} changed in the cloud during sync. Sync again.`);
      this.versions.set(name, cloud.version);
    }
    this.say(`Publishing “${mine.message.split("\n")[0]}” to ${name}`);
    const snapshot = await this.local.readSnapshot(oid);
    const saved = await this.cloud.saveDraft({
      projectId: this.pid,
      branchId: name,
      baseCommit: remote.cloudHead,
      expectedVersion: this.versions.get(name)!,
      draft: snapshot,
      requestId: this.requestId(),
    });
    if (saved.status !== "accepted" || saved.version === undefined) {
      this.versions.delete(name);
      return fail(
        saved.error ?? "The cloud draft changed during sync. Sync again.",
      );
    }
    this.versions.set(name, saved.version);
    this.cloudText.set(name, mine.blob);
    const committed = await this.cloud.commitDraft({
      projectId: this.pid,
      branchId: name,
      expectedHead: remote.cloudHead,
      draftVersion: saved.version,
      message: mine.message,
      requestId: this.requestId(),
    });
    if (committed.status !== "succeeded" || !committed.commitId)
      return fail(
        committed.error ?? `Couldn’t publish to ${name}. Sync again.`,
      );
    // The backend moves the unchanged working draft onto the new revision.
    this.versions.set(name, saved.version + 1);
    const revision = await this.cloud.commit(this.pid, committed.commitId);
    if (!revision)
      return fail("The published revision could not be read back. Sync again.");
    const [imported] = await this.local.importCommits([
      this.importable(revision, {}),
    ]);
    await this.local.updateRefs({
      remotes: this.state.remotes.map((r) =>
        r.name === name
          ? { ...r, head: imported.local, cloudHead: committed.commitId! }
          : r,
      ),
    });
    await this.refresh();
    // Normally the cloud stored exactly the text we sent, so it is already here.
    await this.ensureContent([imported.local]);
    this.report.published[name] = (this.report.published[name] ?? 0) + 1;
    // The next round's adopt() swaps the offline revision for the cloud one.
    return true;
  }

  private async pushDrafts() {
    if (this.role === "reviewer") return;
    await this.refresh();
    const published = this.published();
    for (const draft of [...this.state.drafts]) {
      const name = draft.branch;
      this.check();
      const remote = this.remote(name);
      if (!remote || this.blocked.has(name) || !this.versions.has(name))
        continue;
      const mine = await this.local.loadDraft(name);
      const myBlob = await this.blobOf(mine.draft);
      const version = this.versions.get(name)!;
      if (this.cloudText.get(name) === myBlob) {
        await this.local.setDraftSync(name, {
          cloudVersion: version,
          syncedBlob: myBlob,
        });
        continue;
      }
      // The cloud needs a base it knows: the newest published revision under the draft.
      const base = published.has(mine.baseCommit)
        ? mine.baseCommit
        : (firstParentChain(this.graph, mine.baseCommit, published).base ??
          remote.head);
      this.say(`Saving the working draft on ${name} to the cloud`);
      const saved = await this.cloud.saveDraft({
        projectId: this.pid,
        branchId: name,
        baseCommit: this.toCloud(base),
        expectedVersion: version,
        draft: mine.draft,
        requestId: this.requestId(),
      });
      if (saved.status !== "accepted" || saved.version === undefined) {
        this.attention({
          kind: "failed",
          branch: name,
          message:
            saved.error ?? "The working draft could not be saved to the cloud.",
        });
        continue;
      }
      this.versions.set(name, saved.version);
      this.cloudText.set(name, myBlob);
      await this.local.setDraftSync(name, {
        cloudVersion: saved.version,
        syncedBlob: myBlob,
      });
      this.report.draftsPushed.push(name);
    }
  }

  private async finish() {
    await this.refresh();
    await this.local.setMeta({
      cloud: {
        cloned: this.state.remotes.every((r) => this.branch(r.name)),
        lastSyncedAt: (this.options.now ?? Date.now)(),
      },
    });
    // Everything else, so the whole history can be read offline. Losing the
    // connection here leaves the rest for the next sync.
    const rest = [...this.graph.values()]
      .filter((c) => !c.hasContent)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((c) => c.oid);
    try {
      await this.ensureContent(rest, "Downloading history");
    } catch (error) {
      if (error instanceof Aborted || error instanceof SyncInterrupted)
        throw error;
      await this.refresh();
    }
    this.report.contentPending = [...this.graph.values()].filter(
      (c) => !c.hasContent,
    ).length;
  }
}
