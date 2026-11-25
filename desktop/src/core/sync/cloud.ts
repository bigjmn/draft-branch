/** What sync needs from DraftBranch cloud. The app implements this with the
 * same callable functions and Firestore reads the web app uses; tests implement
 * it with an in-memory model of the backend. */
import type {
  CommitResult,
  EditorOptions,
  MergeNote,
  Role,
  SaveResult,
} from "../types";

export interface CloudCommit {
  oid: string;
  tree: string;
  blob: string;
  parent: string[];
  message: string;
  actorUid: string;
  /** Recorded on revisions made after author names were added to the backend. */
  authorName?: string | null;
  /** Seconds since the epoch. */
  timestamp: number;
  merge?: MergeNote;
}
export interface CloudBranch {
  name: string;
  head: string;
  protected: boolean;
  createdBy?: string | null;
  /** Set on an editor's dedicated branch. */
  dedicatedTo?: string | null;
}
/** The signed-in account's working draft on a branch, or the branch head when
 * it has none (version 0). */
export interface CloudDraft {
  draft: unknown;
  version: number;
  baseCommit: string;
  head: string;
}

export interface CloudApi {
  readonly uid: string;
  /** Null when this account cannot open the project (removed, or deleted). */
  access(
    projectId: string,
  ): Promise<{ title: string; role: Role; options?: EditorOptions } | null>;
  branches(projectId: string): Promise<CloudBranch[]>;
  commits(projectId: string): Promise<CloudCommit[]>;
  commit(projectId: string, oid: string): Promise<CloudCommit | null>;
  /** Display names per member uid, for revisions that predate `authorName`. */
  memberNames(projectId: string): Promise<Record<string, string[]>>;
  readRevision(projectId: string, oid: string): Promise<unknown>;
  loadDraft(projectId: string, branch: string): Promise<CloudDraft>;
  /** Resolves once the backend has accepted or refused the upload. */
  saveDraft(input: {
    projectId: string;
    branchId: string;
    baseCommit: string;
    expectedVersion: number;
    draft: unknown;
    requestId: string;
  }): Promise<SaveResult>;
  /** Resolves once the commit worker has finished. */
  commitDraft(input: {
    projectId: string;
    branchId: string;
    expectedHead: string;
    draftVersion: number;
    message: string;
    requestId: string;
  }): Promise<CommitResult>;
  createBranch(input: {
    projectId: string;
    name: string;
    sourceBranch: string;
    expectedHead: string;
    requestId: string;
  }): Promise<void>;
  renameProject(projectId: string, title: string): Promise<void>;
}

export type CloudErrorKind = "offline" | "denied" | "not-found" | "other";
export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}
