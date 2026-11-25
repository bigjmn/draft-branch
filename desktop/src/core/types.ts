/** Types shared by the main process, the renderer, and the sync engine. */
import type { Snapshot } from "./snapshot";

export type Role = "owner" | "editor" | "commenter" | "reviewer";
/** An editor's options, as the owner chose them (see functions/src/projects/permissions.ts). */
export interface EditorOptions {
  editMain?: boolean;
  commentMain?: boolean;
  branch?: string | null;
}

/** Projects made on this device, with no account. */
export const LOCAL_SCOPE = "local";
/** Where a project lives in the library: LOCAL_SCOPE or the account that pulled it. */
export interface ProjectRef {
  scope: string;
  id: string;
}

export interface CloudLink {
  uid: string;
  role: Role;
  /** An editor's options; absent for other roles. */
  options?: EditorOptions;
  /** "revoked" once the cloud says this account can no longer open the project. */
  access: "ok" | "revoked";
  /** True once a pull has brought down every branch; the project can be opened. */
  cloned: boolean;
  lastSyncedAt?: number;
  /** A project rename made offline, sent on the next sync. */
  pendingTitle?: string;
}
export interface ProjectMeta {
  schema: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  openedAt?: number;
  defaultBranch: string;
  lastBranch?: string;
  cloud?: CloudLink;
}

export interface BranchRef {
  name: string;
  head: string;
  protected: boolean;
  /** Branch this one was created from. */
  source?: string;
}
/** Where a cloud branch was at the last sync. */
export interface RemoteRef {
  name: string;
  /** Id of that revision in this device's repository. */
  head: string;
  /** Id of the same revision in the cloud. Almost always equal to `head`. */
  cloudHead: string;
  protected: boolean;
}
export interface DraftSummary {
  branch: string;
  version: number;
  baseCommit: string;
  /** No writing beyond the revision it is based on. */
  clean: boolean;
  updatedAt: number;
}
export interface ProjectState {
  meta: ProjectMeta;
  branches: BranchRef[];
  remotes: RemoteRef[];
  drafts: DraftSummary[];
}

export interface CommitInfo {
  oid: string;
  parent: string[];
  tree: string;
  blob: string;
  message: string;
  authorName: string;
  /** Stable per-author key (the local part of the commit email). */
  authorKey: string;
  /** Seconds since the epoch. */
  timestamp: number;
  merge?: MergeNote;
  /** False while a pulled revision's screenplay text is still to be downloaded. */
  hasContent: boolean;
}
export interface MergeNote {
  sourceBranch: string;
  targetBranch: string;
}

export interface LoadedDraft {
  draft: Snapshot;
  version: number;
  baseCommit: string;
  head: string;
  clean: boolean;
  /** False when no working draft has been saved yet (the head revision is returned). */
  stored: boolean;
}
export interface SaveDraftInput {
  branch: string;
  baseCommit: string;
  expectedVersion: number;
  draft: unknown;
}
export interface SaveResult {
  status: "accepted" | "conflict" | "rejected";
  version?: number;
  error?: string;
}

/** Display name recorded on a revision. The identity behind it (this device, or
 * the signed-in account for a cloud project) is decided by the project itself. */
export interface AuthorInput {
  name: string;
}
export interface CommitInput {
  branch: string;
  expectedHead: string;
  draftVersion: number;
  message: string;
  author: AuthorInput;
}
export interface CommitResult {
  status: "succeeded" | "conflict" | "rejected";
  commitId?: string;
  error?: string;
}
export interface CreateBranchInput {
  name: string;
  sourceBranch: string;
  expectedHead: string;
}
export interface MergeCommitInput {
  sourceBranch: string;
  targetBranch: string;
  expectedSourceHead: string;
  expectedTargetHead: string;
  /** The merged screenplay. */
  snapshot: unknown;
  message: string;
  author: AuthorInput;
}

/** A cloud revision's metadata, enough to rebuild its Git commit object here. */
export interface ImportCommit {
  oid: string;
  tree: string;
  blob: string;
  parent: string[];
  message: string;
  actorUid: string;
  /** Candidate author names, most likely first. */
  authorNames: string[];
  timestamp: number;
  merge?: MergeNote;
}
export interface ImportResult {
  /** Cloud id. */
  oid: string;
  /** Id in this device's repository. */
  local: string;
  /** True when the rebuilt commit is byte-identical to the cloud's. */
  exact: boolean;
}
export interface RawCommitInput {
  parent: string[];
  /** Give the screenplay, or reuse the tree of an existing local commit. */
  snapshot?: unknown;
  treeOf?: string;
  message: string;
  authorName: string;
  authorKey: string;
  timestamp: number;
}
/** One atomic change to refs. `expected` guards against a concurrent move. */
export interface RefUpdate {
  branches?: Record<
    string,
    {
      head: string;
      expected?: string | null;
      protected?: boolean;
      source?: string;
      /** If this branch's working draft is based on a key, move it to the
       * value: the same text under a new revision id. */
      rebaseDraft?: Record<string, string>;
    }
  >;
  /** Replaces the whole set of cloud branch positions when given. */
  remotes?: RemoteRef[];
}
export interface SetDraftInput {
  branch: string;
  expectedVersion: number;
  draft?: unknown;
  baseCommit?: string;
}

export interface DraftSyncState {
  /** Version of the cloud working draft when it last matched this device. */
  cloudVersion: number;
  /** Git blob id of the text both sides agreed on at that point. */
  syncedBlob: string;
}
export interface SyncState {
  /** Cloud commit id → local commit id, only where the two differ. */
  oidMap: Record<string, string>;
  drafts: Record<string, DraftSyncState>;
}

/** Everything the renderer can ask of one project. Implemented by ProjectStore. */
export interface ProjectApi {
  state(): Promise<ProjectState>;
  commits(): Promise<CommitInfo[]>;
  readSnapshot(commit: string): Promise<Snapshot>;
  readBlob(blob: string): Promise<Snapshot>;
  loadDraft(branch: string): Promise<LoadedDraft>;
  saveDraft(input: SaveDraftInput): Promise<SaveResult>;
  commit(input: CommitInput): Promise<CommitResult>;
  createBranch(input: CreateBranchInput): Promise<BranchRef>;
  mergeCommit(input: MergeCommitInput): Promise<{ oid: string }>;
  setMeta(
    patch: Partial<Pick<ProjectMeta, "title" | "lastBranch" | "openedAt">> & {
      cloud?: Partial<CloudLink>;
    },
  ): Promise<ProjectMeta>;
  // Used by sync.
  importCommits(commits: ImportCommit[]): Promise<ImportResult[]>;
  writeSnapshot(
    snapshot: unknown,
    expectedBlob?: string,
  ): Promise<{ blob: string }>;
  createCommit(input: RawCommitInput): Promise<{ oid: string }>;
  updateRefs(update: RefUpdate): Promise<ProjectState>;
  setDraft(input: SetDraftInput): Promise<SaveResult>;
  syncState(): Promise<SyncState>;
  setDraftSync(branch: string, value: DraftSyncState | null): Promise<void>;
}
export type ProjectMethod = keyof ProjectApi;

export interface ProjectSummary {
  ref: ProjectRef;
  meta: ProjectMeta;
  branches: number;
  /** Revisions and branches made here that the cloud does not have yet. */
  unpublished: number;
  /** Cloud revisions seen at the last sync that are not in the local branches yet. */
  incoming: number;
  /** Branches whose working draft has writing beyond its revision. */
  drafts: number;
}
export interface DeviceSettings {
  /** Name recorded on revisions of projects kept only on this device. */
  writerName: string;
  /** Stable id for this installation's author identity. */
  writerId: string;
}
