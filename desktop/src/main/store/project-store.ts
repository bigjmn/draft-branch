/** One screenplay project on disk.
 *
 *   <project>/project.json   title, timestamps, cloud link
 *   <project>/state.json     branch heads, last-known cloud heads, sync bookkeeping
 *   <project>/git/           a bare Git repository holding every revision
 *   <project>/drafts/        one working draft per branch
 *
 * It behaves like the backend's ProjectService (functions/src/projects/service.ts)
 * so the editor and version-control UI run unchanged against it: drafts carry a
 * version and a base commit, commits need a saved draft on the branch head, and
 * protected branches accept the owner only.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InvalidInput,
  type Snapshot,
  authorName,
  blankSnapshot,
  branchName,
  commitMessage,
  isBranchName,
  isOid,
  isProjectId,
  oid as oidInput,
  parseSnapshot,
  projectTitle,
  serializeSnapshot,
} from "../../core/snapshot";
import type {
  BranchRef,
  CloudLink,
  CommitInfo,
  CommitInput,
  CommitResult,
  CreateBranchInput,
  DraftSummary,
  DraftSyncState,
  ImportCommit,
  ImportResult,
  LoadedDraft,
  MergeCommitInput,
  MergeNote,
  ProjectApi,
  ProjectMeta,
  ProjectState,
  RawCommitInput,
  RefUpdate,
  Role,
  SaveDraftInput,
  SaveResult,
  SetDraftInput,
  SyncState,
} from "../../core/types";
import { Mutex, readJson, writeFileAtomic } from "./atomic";
import {
  accountAuthorKey,
  authorEmail,
  authorKeyOf,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  oidOf,
} from "./git-objects";
import { MissingObject, ObjectStore } from "./object-store";

export type StoreErrorCode =
  | "not-found"
  | "conflict"
  | "forbidden"
  | "invalid"
  | "missing-content"
  | "damaged";
/** An expected failure. `message` is written for the person using the app. */
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

interface BranchEntry {
  head: string;
  protected: boolean;
  source?: string;
}
interface StateFile {
  schema: 1;
  branches: Record<string, BranchEntry>;
  remotes: Record<
    string,
    { head: string; cloudHead: string; protected: boolean }
  >;
  merges: Record<string, MergeNote>;
  sync: SyncState;
}
interface DraftFile {
  schema: 1;
  version: number;
  baseCommit: string;
  updatedAt: number;
  draft: Snapshot;
}
type StoredCommit = Omit<CommitInfo, "merge" | "hasContent">;

export interface CreateProject {
  id: string;
  title: string;
  /** Present for a project pulled from the cloud; its branches arrive by sync. */
  cloud?: Pick<CloudLink, "uid" | "role">;
  /** First revision of a project made on this device. Blank when omitted. */
  snapshot?: unknown;
  authorName?: string;
}

const WRITERS: Role[] = ["owner", "editor"];
const now = () => Date.now();
const seconds = () => Math.floor(Date.now() / 1000);
const emptyState = (): StateFile => ({
  schema: 1,
  branches: {},
  remotes: {},
  merges: {},
  sync: { oidMap: {}, drafts: {} },
});

export class ProjectStore implements ProjectApi {
  private readonly lock = new Mutex();
  private readonly objects: ObjectStore;
  private readonly commitCache = new Map<string, StoredCommit>();
  private readonly cleanCache = new Map<string, boolean>();
  private metaCache: ProjectMeta | null = null;
  private stateCache: StateFile | null = null;

  /** `deviceKey` identifies this installation as the author of offline-only projects. */
  constructor(
    readonly dir: string,
    private readonly deviceKey: string,
  ) {
    this.objects = new ObjectStore(join(dir, "git"));
  }

  static async create(
    dir: string,
    deviceKey: string,
    init: CreateProject,
  ): Promise<ProjectStore> {
    if (!isProjectId(init.id))
      throw new StoreError("invalid", "Invalid project id.");
    const title = projectTitle(init.title);
    const store = new ProjectStore(dir, deviceKey);
    await mkdir(join(dir, "drafts"), { recursive: true });
    await store.objects.init("main");
    const state = emptyState();
    if (!init.cloud) {
      const snapshot = parseSnapshot(
        init.snapshot === undefined
          ? blankSnapshot(title)
          : { ...(init.snapshot as object), title },
      );
      const tree = await store.putTree(snapshot);
      const head = await store.objects.put(
        "commit",
        encodeCommit({
          tree,
          parent: [],
          author: {
            name: authorName(init.authorName),
            email: authorEmail(deviceKey),
            timestamp: seconds(),
          },
          message: "Create project",
        }),
      );
      state.branches.main = { head, protected: true };
    }
    const meta: ProjectMeta = {
      schema: 1,
      id: init.id,
      title,
      createdAt: now(),
      updatedAt: now(),
      defaultBranch: "main",
      ...(init.cloud
        ? {
            cloud: {
              uid: init.cloud.uid,
              role: init.cloud.role,
              access: "ok" as const,
              cloned: false,
            },
          }
        : {}),
    };
    // project.json goes last: a folder without it is an unfinished creation.
    await store.writeState(state);
    await store.writeMeta(meta);
    return store;
  }

  // ---------------------------------------------------------------- files

  private async readMeta(): Promise<ProjectMeta> {
    if (this.metaCache) return this.metaCache;
    const meta = await readJson<ProjectMeta>(join(this.dir, "project.json"), {
      backup: true,
    });
    if (!meta || meta.schema !== 1 || !isProjectId(meta.id))
      throw new StoreError("not-found", "Project not found on this device.");
    return (this.metaCache = meta);
  }
  private async writeMeta(meta: ProjectMeta) {
    await writeFileAtomic(
      join(this.dir, "project.json"),
      JSON.stringify(meta, null, 2) + "\n",
      { backup: true },
    );
    this.metaCache = meta;
  }
  private async readState(): Promise<StateFile> {
    if (this.stateCache) return this.stateCache;
    const state = await readJson<StateFile>(join(this.dir, "state.json"), {
      backup: true,
    });
    if (!state || state.schema !== 1 || typeof state.branches !== "object")
      throw new StoreError(
        "damaged",
        "This project's branch list is damaged. Its revisions are still on disk.",
      );
    state.remotes ??= {};
    state.merges ??= {};
    state.sync ??= { oidMap: {}, drafts: {} };
    state.sync.oidMap ??= {};
    state.sync.drafts ??= {};
    return (this.stateCache = state);
  }
  private async writeState(state: StateFile) {
    await writeFileAtomic(
      join(this.dir, "state.json"),
      JSON.stringify(state, null, 2) + "\n",
      { backup: true },
    );
    this.stateCache = state;
    await this.mirrorRefs(state).catch(() => {});
  }
  /** Keep ordinary Git refs in step so other Git tools can browse the history.
   * state.json stays the source of truth; a name the file system refuses (for
   * example a reserved device name on Windows) is simply skipped. */
  private async mirrorRefs(state: StateFile) {
    const sync = async (
      folder: string,
      wanted: Record<string, { head: string }>,
    ) => {
      await mkdir(folder, { recursive: true });
      for (const [name, ref] of Object.entries(wanted))
        await writeFile(join(folder, name), ref.head + "\n").catch(() => {});
      for (const name of await readdir(folder))
        if (!(name in wanted)) await rm(join(folder, name), { force: true });
    };
    await sync(join(this.objects.gitdir, "refs", "heads"), state.branches);
    await sync(
      join(this.objects.gitdir, "refs", "remotes", "origin"),
      state.remotes,
    );
  }
  private draftPath(branch: string) {
    return join(this.dir, "drafts", `b-${branch}.json`);
  }
  private async readDraft(branch: string): Promise<DraftFile | null> {
    const file = await readJson<DraftFile>(this.draftPath(branch), {
      backup: true,
    });
    if (!file) return null;
    if (!Number.isSafeInteger(file.version) || !isOid(file.baseCommit))
      throw new StoreError("damaged", "A working draft file is damaged.");
    return { ...file, draft: parseSnapshot(file.draft) };
  }
  private async writeDraft(
    branch: string,
    file: Omit<DraftFile, "schema" | "updatedAt">,
  ) {
    await writeFileAtomic(
      this.draftPath(branch),
      JSON.stringify({ schema: 1, updatedAt: now(), ...file }) + "\n",
      { backup: true },
    );
  }

  // -------------------------------------------------------------- objects

  private async putTree(snapshot: unknown): Promise<string> {
    const blob = await this.objects.put(
      "blob",
      Buffer.from(serializeSnapshot(snapshot)),
    );
    return this.objects.put("tree", encodeTree(blob));
  }
  private async commitOf(oid: string): Promise<StoredCommit> {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    let fields;
    try {
      fields = decodeCommit((await this.objects.get(oid, "commit")).content);
    } catch (error) {
      if (error instanceof MissingObject)
        throw new StoreError("not-found", "Revision not found.");
      throw error;
    }
    const blob = decodeTree(
      (await this.objects.get(fields.tree, "tree")).content,
    );
    const commit: StoredCommit = {
      oid,
      parent: fields.parent,
      tree: fields.tree,
      blob,
      message: fields.message,
      authorName: fields.author.name,
      authorKey: authorKeyOf(fields.author.email),
      timestamp: fields.author.timestamp,
    };
    this.commitCache.set(oid, commit);
    return commit;
  }
  private async hasCommit(oid: string) {
    return this.commitCache.has(oid) || (await this.objects.has(oid));
  }
  private async role(): Promise<Role> {
    const cloud = (await this.readMeta()).cloud;
    if (!cloud) return "owner";
    return cloud.access === "ok" ? cloud.role : "reviewer";
  }
  private async authorFor(name: unknown) {
    const cloud = (await this.readMeta()).cloud;
    return {
      name: authorName(name),
      email: authorEmail(cloud ? accountAuthorKey(cloud.uid) : this.deviceKey),
      timestamp: seconds(),
    };
  }

  // ---------------------------------------------------------------- reads

  /** Reads wait for writes in progress, so a caller that asks after a change
   * was requested always sees that change in full (refs and drafts together). */
  state(): Promise<ProjectState> {
    return this.lock.run(() => this.readProjectState());
  }
  private async readProjectState(): Promise<ProjectState> {
    const [meta, state] = await Promise.all([
      this.readMeta(),
      this.readState(),
    ]);
    const drafts: DraftSummary[] = [];
    for (const name of Object.keys(state.branches)) {
      let file: DraftFile | null;
      try {
        file = await this.readDraft(name);
      } catch {
        continue; // A damaged draft is reported when its branch is opened.
      }
      if (!file) continue;
      const head = state.branches[name].head;
      const clean = await this.isClean(name, file, head);
      drafts.push({
        branch: name,
        version: file.version,
        baseCommit: clean ? head : file.baseCommit,
        clean,
        updatedAt: file.updatedAt,
      });
    }
    return {
      meta,
      branches: branchList(state),
      remotes: Object.entries(state.remotes).map(([name, ref]) => ({
        name,
        ...ref,
      })),
      drafts,
    };
  }

  /** True when a draft holds no writing beyond a revision: its text is exactly
   * its base revision, or exactly the branch head. */
  private async isClean(
    branch: string,
    file: DraftFile,
    head: string,
  ): Promise<boolean> {
    const key = `${branch}:${file.version}:${file.baseCommit}:${head}`;
    const cached = this.cleanCache.get(key);
    if (cached !== undefined) return cached;
    const blob = oidOf("blob", Buffer.from(serializeSnapshot(file.draft)));
    let clean = false;
    for (const commit of new Set([file.baseCommit, head])) {
      try {
        if ((await this.commitOf(commit)).blob === blob) clean = true;
      } catch {
        /* A missing base cannot prove the draft clean. */
      }
    }
    if (this.cleanCache.size > 200) this.cleanCache.clear();
    this.cleanCache.set(key, clean);
    return clean;
  }

  async commits(): Promise<CommitInfo[]> {
    const state = await this.readState();
    const result: CommitInfo[] = [];
    const seen = new Set<string>();
    const stack = [
      ...Object.values(state.branches).map((b) => b.head),
      ...Object.values(state.remotes).map((r) => r.head),
    ];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      let commit: StoredCommit;
      try {
        commit = await this.commitOf(oid);
      } catch {
        continue; // History stops at a revision this device does not have.
      }
      result.push({
        ...commit,
        ...(state.merges[oid] ? { merge: state.merges[oid] } : {}),
        hasContent: await this.objects.has(commit.blob),
      });
      stack.push(...commit.parent);
    }
    return result;
  }

  async readSnapshot(commit: string): Promise<Snapshot> {
    return this.readBlob((await this.commitOf(oidInput(commit))).blob);
  }
  async readBlob(blob: string): Promise<Snapshot> {
    try {
      const { content } = await this.objects.get(oidInput(blob), "blob");
      return parseSnapshot(JSON.parse(content.toString("utf8")));
    } catch (error) {
      if (error instanceof MissingObject)
        throw new StoreError("missing-content", error.message);
      throw error;
    }
  }

  loadDraft(branch: string): Promise<LoadedDraft> {
    return this.lock.run(() => this.readLoadedDraft(branch));
  }
  private async readLoadedDraft(branch: string): Promise<LoadedDraft> {
    const name = branchName(branch);
    const entry = (await this.readState()).branches[name];
    if (!entry) throw new StoreError("not-found", "Branch not found.");
    const head = entry.head;
    const file = await this.readDraft(name);
    if (!file)
      return {
        draft: await this.readSnapshot(head),
        version: 0,
        baseCommit: head,
        head,
        clean: true,
        stored: false,
      };
    // A draft with no writing of its own follows the branch, so someone who
    // has not typed anything never opens a stale screenplay after a pull.
    if (await this.isClean(name, file, head))
      return {
        draft:
          file.baseCommit === head ? file.draft : await this.readSnapshot(head),
        version: file.version,
        baseCommit: head,
        head,
        clean: true,
        stored: true,
      };
    return {
      draft: file.draft,
      version: file.version,
      baseCommit: file.baseCommit,
      head,
      clean: false,
      stored: true,
    };
  }

  // --------------------------------------------------------------- writes

  saveDraft(input: SaveDraftInput): Promise<SaveResult> {
    return this.lock.run(async () => {
      if (!WRITERS.includes(await this.role()))
        return rejected("Read-only access cannot save drafts.");
      return this.storeDraft({
        branch: input.branch,
        expectedVersion: input.expectedVersion,
        draft: input.draft,
        baseCommit: input.baseCommit,
      });
    });
  }
  setDraft(input: SetDraftInput): Promise<SaveResult> {
    return this.lock.run(() => this.storeDraft(input));
  }
  private async storeDraft(input: SetDraftInput): Promise<SaveResult> {
    if (!isBranchName(input.branch)) return rejected("Branch not found.");
    const state = await this.readState();
    const entry = state.branches[input.branch];
    if (!entry) return rejected("Branch not found.");
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      return rejected("Invalid draft version.");
    const file = await this.readDraft(input.branch);
    if ((file?.version ?? 0) !== input.expectedVersion)
      return {
        status: "conflict",
        error: "The draft changed. Reload before saving.",
      };
    const baseCommit = input.baseCommit ?? file?.baseCommit ?? entry.head;
    if (!isOid(baseCommit) || !(await this.hasCommit(baseCommit)))
      return rejected("Base revision not found.");
    let draft: Snapshot;
    try {
      draft =
        input.draft === undefined
          ? (file?.draft ?? (await this.readSnapshot(entry.head)))
          : parseSnapshot(input.draft);
    } catch (error) {
      if (error instanceof InvalidInput) return rejected(error.message);
      throw error;
    }
    const version = input.expectedVersion + 1;
    await this.writeDraft(input.branch, { version, baseCommit, draft });
    await this.touch();
    return { status: "accepted", version };
  }

  commit(input: CommitInput): Promise<CommitResult> {
    return this.lock.run(async () => {
      let branch: string, expectedHead: string, message: string;
      try {
        branch = branchName(input.branch);
        expectedHead = oidInput(input.expectedHead);
        message = commitMessage(input.message);
      } catch (error) {
        return { status: "rejected", error: messageOf(error) };
      }
      const state = await this.readState();
      const entry = state.branches[branch];
      if (!entry) return { status: "rejected", error: "Branch not found." };
      const denied = publishDenied(await this.role(), entry);
      if (denied) return { status: "rejected", error: denied };
      if (entry.head !== expectedHead)
        return {
          status: "conflict",
          error: "Branch advanced. Bring in updates before committing.",
        };
      const file = await this.readDraft(branch);
      if (
        !file ||
        file.version !== input.draftVersion ||
        file.baseCommit !== expectedHead
      )
        return {
          status: "rejected",
          error: "Save a current draft based on this branch head first.",
        };
      const tree = await this.putTree(file.draft);
      const commitId = await this.objects.put(
        "commit",
        encodeCommit({
          tree,
          parent: [expectedHead],
          author: await this.authorFor(input.author?.name),
          message,
        }),
      );
      await this.writeState({
        ...state,
        branches: { ...state.branches, [branch]: { ...entry, head: commitId } },
      });
      // The unchanged draft now sits on the new revision.
      await this.writeDraft(branch, {
        version: file.version + 1,
        baseCommit: commitId,
        draft: file.draft,
      });
      await this.touch(true);
      return { status: "succeeded", commitId };
    });
  }

  createBranch(input: CreateBranchInput): Promise<BranchRef> {
    return this.lock.run(async () => {
      const name = branchName(input.name);
      const source = branchName(input.sourceBranch);
      const expectedHead = oidInput(input.expectedHead);
      if (!WRITERS.includes(await this.role()))
        throw new StoreError(
          "forbidden",
          "Read-only access cannot create branches.",
        );
      const state = await this.readState();
      if (state.branches[name])
        throw new StoreError("conflict", "Branch already exists.");
      const from = state.branches[source];
      if (!from) throw new StoreError("not-found", "Source branch not found.");
      if (from.head !== expectedHead)
        throw new StoreError("conflict", "Source branch advanced.");
      const entry: BranchEntry = {
        head: expectedHead,
        protected: false,
        source,
      };
      await this.writeState({
        ...state,
        branches: { ...state.branches, [name]: entry },
      });
      await this.touch(true);
      return { name, ...entry };
    });
  }

  /** A two-parent merge revision on the target branch. Cloud projects merge on
   * the server instead, where the owner's approval is enforced. */
  mergeCommit(input: MergeCommitInput): Promise<{ oid: string }> {
    return this.lock.run(async () => {
      if ((await this.readMeta()).cloud)
        throw new StoreError(
          "forbidden",
          "Branches of a cloud project are merged online.",
        );
      const sourceBranch = branchName(input.sourceBranch);
      const targetBranch = branchName(input.targetBranch);
      if (sourceBranch === targetBranch)
        throw new StoreError(
          "invalid",
          "Choose two different branches to merge.",
        );
      const state = await this.readState();
      const source = state.branches[sourceBranch];
      const target = state.branches[targetBranch];
      if (!source || !target)
        throw new StoreError("not-found", "Branch not found.");
      if (
        source.head !== input.expectedSourceHead ||
        target.head !== input.expectedTargetHead
      )
        throw new StoreError(
          "conflict",
          "A branch changed. Review the merge again.",
        );
      const tree = await this.putTree(input.snapshot);
      const oid = await this.objects.put(
        "commit",
        encodeCommit({
          tree,
          parent: [target.head, source.head],
          author: await this.authorFor(input.author?.name),
          message: commitMessage(input.message),
        }),
      );
      await this.writeState({
        ...state,
        branches: {
          ...state.branches,
          [targetBranch]: { ...target, head: oid },
        },
        merges: { ...state.merges, [oid]: { sourceBranch, targetBranch } },
      });
      await this.touch(true);
      return { oid };
    });
  }

  setMeta(patch: Parameters<ProjectApi["setMeta"]>[0]): Promise<ProjectMeta> {
    return this.lock.run(async () => {
      const meta = await this.readMeta();
      const next: ProjectMeta = { ...meta };
      if (patch.title !== undefined) next.title = projectTitle(patch.title);
      if (patch.lastBranch !== undefined)
        next.lastBranch = branchName(patch.lastBranch);
      if (patch.openedAt !== undefined) next.openedAt = Number(patch.openedAt);
      if (patch.cloud && meta.cloud) {
        const cloud = { ...meta.cloud };
        const p = patch.cloud;
        if (p.role && ["owner", "editor", "reviewer"].includes(p.role))
          cloud.role = p.role;
        if (p.access === "ok" || p.access === "revoked")
          cloud.access = p.access;
        if (typeof p.cloned === "boolean") cloud.cloned = p.cloned;
        if (typeof p.lastSyncedAt === "number")
          cloud.lastSyncedAt = p.lastSyncedAt;
        if ("pendingTitle" in p) {
          if (p.pendingTitle) cloud.pendingTitle = projectTitle(p.pendingTitle);
          else delete cloud.pendingTitle;
        }
        next.cloud = cloud;
      }
      // Opening a project or recording a sync is not an edit; a rename is.
      if (next.title !== meta.title) next.updatedAt = now();
      await this.writeMeta(next);
      return next;
    });
  }
  /** Record activity for the library's "recently edited" order. Draft saves
   * happen every few hundred milliseconds, so those are throttled. */
  private async touch(force = false) {
    const meta = await this.readMeta();
    if (!force && now() - meta.updatedAt < 60_000) return;
    await this.writeMeta({ ...meta, updatedAt: now() });
  }

  // ----------------------------------------------------------------- sync

  importCommits(commits: ImportCommit[]): Promise<ImportResult[]> {
    return this.lock.run(async () => {
      const state = await this.readState();
      const oidMap = { ...state.sync.oidMap };
      const merges = { ...state.merges };
      const results: ImportResult[] = [];
      for (const commit of commits) {
        if (
          !isOid(commit.oid) ||
          !isOid(commit.tree) ||
          !isOid(commit.blob) ||
          !Array.isArray(commit.parent) ||
          !commit.parent.every(isOid) ||
          typeof commit.message !== "string" ||
          typeof commit.actorUid !== "string" ||
          !Array.isArray(commit.authorNames) ||
          !Number.isSafeInteger(commit.timestamp)
        )
          throw new StoreError("invalid", "A pulled revision is malformed.");
        const known =
          oidMap[commit.oid] ??
          ((await this.objects.has(commit.oid)) ? commit.oid : null);
        if (known) {
          results.push({
            oid: commit.oid,
            local: known,
            exact: known === commit.oid,
          });
          continue;
        }
        const tree = encodeTree(commit.blob);
        if (oidOf("tree", tree) !== commit.tree)
          throw new StoreError(
            "invalid",
            "This project uses a revision format this version of DraftBranch cannot read. Update the app.",
          );
        await this.objects.put("tree", tree);
        const parent = commit.parent.map((p) => oidMap[p] ?? p);
        for (const p of parent)
          if (!(await this.objects.has(p)))
            throw new StoreError(
              "invalid",
              "A pulled revision arrived before its parent.",
            );
        const identical = parent.every((p, i) => p === commit.parent[i]);
        const email = authorEmail(accountAuthorKey(commit.actorUid));
        // The commit's bytes include the author name as it was when the
        // revision was made. Try each candidate until the hash matches.
        let chosen: Buffer | null = null;
        let exact = false;
        const names = commit.authorNames.filter(
          (name) => typeof name === "string" && name && !/[\n\r<>]/.test(name),
        );
        for (const name of names.length ? names : ["Writer"]) {
          const content = encodeCommit({
            tree: commit.tree,
            parent,
            author: { name, email, timestamp: commit.timestamp },
            message: commit.message,
          });
          chosen ??= content;
          if (identical && oidOf("commit", content) === commit.oid) {
            chosen = content;
            exact = true;
            break;
          }
        }
        const local = await this.objects.put("commit", chosen!);
        if (local !== commit.oid) oidMap[commit.oid] = local;
        if (
          commit.merge &&
          isBranchName(commit.merge.sourceBranch) &&
          isBranchName(commit.merge.targetBranch)
        )
          merges[local] = {
            sourceBranch: commit.merge.sourceBranch,
            targetBranch: commit.merge.targetBranch,
          };
        results.push({ oid: commit.oid, local, exact });
      }
      await this.writeState({
        ...state,
        merges,
        sync: { ...state.sync, oidMap },
      });
      return results;
    });
  }

  async writeSnapshot(
    snapshot: unknown,
    expectedBlob?: string,
  ): Promise<{ blob: string }> {
    const bytes = Buffer.from(serializeSnapshot(snapshot));
    const blob = oidOf("blob", bytes);
    if (expectedBlob !== undefined && blob !== expectedBlob)
      throw new StoreError(
        "invalid",
        "A downloaded revision failed its integrity check and was not saved.",
      );
    await this.objects.put("blob", bytes);
    await this.objects.put("tree", encodeTree(blob));
    return { blob };
  }

  async createCommit(input: RawCommitInput): Promise<{ oid: string }> {
    if (!Array.isArray(input.parent) || !input.parent.every(isOid))
      throw new StoreError("invalid", "Invalid parent revision.");
    for (const p of input.parent)
      if (!(await this.hasCommit(p)))
        throw new StoreError("not-found", "Parent revision not found.");
    if (
      typeof input.authorKey !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(input.authorKey) ||
      !Number.isSafeInteger(input.timestamp) ||
      input.timestamp < 0
    )
      throw new StoreError("invalid", "Invalid revision author.");
    const tree =
      input.snapshot !== undefined
        ? await this.putTree(input.snapshot)
        : (await this.commitOf(oidInput(input.treeOf))).tree;
    const oid = await this.objects.put(
      "commit",
      encodeCommit({
        tree,
        parent: input.parent,
        author: {
          name: authorName(input.authorName),
          email: authorEmail(input.authorKey),
          timestamp: input.timestamp,
        },
        message: commitMessage(input.message),
      }),
    );
    return { oid };
  }

  updateRefs(update: RefUpdate): Promise<ProjectState> {
    return this.lock.run(async () => {
      const state = await this.readState();
      const branches = { ...state.branches };
      for (const [name, change] of Object.entries(update.branches ?? {})) {
        if (
          !isBranchName(name) ||
          !isOid(change.head) ||
          !(await this.hasCommit(change.head))
        )
          throw new StoreError("invalid", "Invalid branch update.");
        const current = branches[name];
        if ("expected" in change && (current?.head ?? null) !== change.expected)
          throw new StoreError(
            "conflict",
            `Branch ${name} changed while syncing. Sync again.`,
          );
        branches[name] = {
          head: change.head,
          protected: change.protected ?? current?.protected ?? false,
          ...((change.source ?? current?.source)
            ? { source: change.source ?? current?.source }
            : {}),
        };
      }
      let remotes = state.remotes;
      if (update.remotes) {
        remotes = {};
        for (const ref of update.remotes) {
          if (
            !isBranchName(ref.name) ||
            !isOid(ref.head) ||
            !isOid(ref.cloudHead) ||
            !(await this.hasCommit(ref.head))
          )
            throw new StoreError("invalid", "Invalid cloud branch update.");
          remotes[ref.name] = {
            head: ref.head,
            cloudHead: ref.cloudHead,
            protected: !!ref.protected,
          };
        }
      }
      await this.writeState({ ...state, branches, remotes });
      for (const [name, change] of Object.entries(update.branches ?? {})) {
        if (!change.rebaseDraft) continue;
        const file = await this.readDraft(name).catch(() => null);
        const target = file && change.rebaseDraft[file.baseCommit];
        if (file && target && isOid(target) && (await this.hasCommit(target)))
          await this.writeDraft(name, {
            version: file.version + 1,
            baseCommit: target,
            draft: file.draft,
          });
      }
      return this.readProjectState();
    });
  }

  async syncState(): Promise<SyncState> {
    const { sync } = await this.readState();
    return { oidMap: { ...sync.oidMap }, drafts: { ...sync.drafts } };
  }
  setDraftSync(branch: string, value: DraftSyncState | null): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.readState();
      const drafts = { ...state.sync.drafts };
      if (
        value &&
        isBranchName(branch) &&
        Number.isSafeInteger(value.cloudVersion) &&
        isOid(value.syncedBlob)
      )
        drafts[branch] = {
          cloudVersion: value.cloudVersion,
          syncedBlob: value.syncedBlob,
        };
      else delete drafts[branch];
      await this.writeState({ ...state, sync: { ...state.sync, drafts } });
    });
  }

  /** Opens a project that already exists on disk. */
  static async open(dir: string, deviceKey: string): Promise<ProjectStore> {
    const store = new ProjectStore(dir, deviceKey);
    await store.readMeta();
    return store;
  }
}

function branchList(state: StateFile): BranchRef[] {
  return Object.entries(state.branches).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}
const rejected = (error: string): SaveResult => ({ status: "rejected", error });
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
/** Same rule as assertPublish in the backend. Returns why not, or null. */
function publishDenied(
  role: Role,
  branch: { protected: boolean },
): string | null {
  if (branch.protected)
    return role === "owner"
      ? null
      : "Only the owner can commit to this protected branch. Create a branch, commit there, then open a merge request.";
  return WRITERS.includes(role) ? null : "Read-only access cannot commit.";
}
