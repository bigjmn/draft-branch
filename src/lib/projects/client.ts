/** Browser-only project API. The existing editor remains local until a project
 * is explicitly selected; do not upload a legacy local draft automatically. */
import { httpsCallable } from "firebase/functions";
import {
  collection,
  query,
  orderBy,
  limit,
  doc,
  getDoc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import {
  firebaseAuth,
  firebaseDb,
  firebaseFunctions,
  firebaseStorage,
} from "@/lib/firebase/client";
import type { Draft } from "@/lib/editor/types";
import type { Resolution } from "@/lib/projects/merge";

export interface Project {
  projectId: string;
  title: string;
  role: "owner" | "editor" | "reviewer";
}
export interface Branch {
  name: string;
  head: string;
  protected: boolean;
}
export interface CloudDraft {
  draft: Draft & { schemaVersion: 1 };
  version: number;
  baseCommit: string;
  head: string;
}
export interface Operation {
  status: "queued" | "succeeded" | "conflict" | "rejected";
  commitId?: string;
  error?: string;
}
export interface UploadResult {
  status: "awaiting_upload" | "accepted" | "conflict" | "rejected";
  version?: number;
  error?: string;
}
async function call<T>(name: string, data: unknown): Promise<T> {
  return (await httpsCallable<unknown, T>(firebaseFunctions(), name)(data))
    .data;
}
export const createProject = (
  title: string,
  requestId = crypto.randomUUID(),
  draft?: Draft,
) =>
  call<{ projectId: string; branchId: string; head: string }>("createProject", {
    title,
    requestId,
    ...(draft ? { draft } : {}),
  });
export const loadProjectDraft = (projectId: string, branchId: string) =>
  call<CloudDraft>("loadProjectDraft", { projectId, branchId });
export const readProjectRevision = (projectId: string, commitId: string) =>
  call<{ draft: Draft; commitId: string; parent: string[] }>(
    "readProjectRevision",
    { projectId, commitId },
  );
export const createBranch = (
  projectId: string,
  name: string,
  sourceBranch: string,
  expectedHead: string,
  requestId = crypto.randomUUID(),
) =>
  call<{ branchId: string; head: string }>("createBranch", {
    projectId,
    name,
    sourceBranch,
    expectedHead,
    requestId,
  });
export const commitDraft = (input: {
  projectId: string;
  branchId: string;
  expectedHead: string;
  draftVersion: number;
  message: string;
  requestId: string;
}) =>
  call<{ operationId: string; status: Operation["status"] }>(
    "commitDraft",
    input,
  );
export const inviteProjectMember = (
  projectId: string,
  email: string,
  role: "editor" | "reviewer",
  requestId = crypto.randomUUID(),
) =>
  call<{ projectId: string; invitationId: string; status: string }>(
    "inviteProjectMember",
    { projectId, email, role, requestId },
  );
export const acceptProjectInvitation = (
  projectId: string,
  invitationId: string,
  token?: string,
) =>
  call<{ projectId: string; role: Project["role"] }>(
    "acceptProjectInvitation",
    { projectId, invitationId, ...(token ? { token } : {}) },
  );
export const removeProjectMember = (projectId: string, uid: string) =>
  call<{ removed: boolean }>("removeProjectMember", { projectId, uid });
export const revokeProjectInvitation = (
  projectId: string,
  invitationId: string,
) =>
  call<{ revoked: boolean }>("revokeProjectInvitation", {
    projectId,
    invitationId,
  });

/** Reuse requestId for retries. An uploaded blob is not a successful cloud save
 * until its ticket is accepted by the Storage trigger. */
export async function uploadProjectDraft(input: {
  projectId: string;
  branchId: string;
  baseCommit: string;
  expectedVersion: number;
  draft: Draft;
  requestId: string;
}): Promise<{ uploadId: string }> {
  const { draft, ...metadata } = input;
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const ticket = await call<{
    uploadId: string;
    path: string;
    status: UploadResult["status"];
  }>("beginDraftUpload", { ...metadata, contentHash });
  if (ticket.status === "awaiting_upload") {
    try {
      await uploadBytes(
        ref(firebaseStorage(), ticket.path),
        new Blob([bytes], { type: "application/json" }),
        { contentType: "application/json" },
      );
    } catch (error) {
      // A retry after the original finalize event completed cannot overwrite the blob.
      const existing = await getDoc(
        doc(
          firebaseDb(),
          "projects",
          input.projectId,
          "uploads",
          ticket.uploadId,
        ),
      );
      if (existing.data()?.status !== "accepted") throw error;
    }
  }
  return { uploadId: ticket.uploadId };
}
export function watchUpload(
  projectId: string,
  uploadId: string,
  next: (value: UploadResult) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(firebaseDb(), "projects", projectId, "uploads", uploadId),
    (snapshot) => {
      if (snapshot.exists()) next(snapshot.data() as UploadResult);
    },
    error,
  );
}
export function watchCommit(
  projectId: string,
  operationId: string,
  next: (value: Operation) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(firebaseDb(), "projects", projectId, "operations", operationId),
    (snapshot) => {
      if (snapshot.exists()) next(snapshot.data() as Operation);
    },
    error,
  );
}
export function watchProjects(
  next: (value: Project[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  const uid = firebaseAuth().currentUser?.uid;
  if (!uid) throw new Error("Sign in first.");
  return onSnapshot(
    collection(firebaseDb(), "users", uid, "projects"),
    (snapshot) => next(snapshot.docs.map((item) => item.data() as Project)),
    error,
  );
}
export function watchBranches(
  projectId: string,
  next: (value: Branch[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(firebaseDb(), "projects", projectId, "branches"),
    (snapshot) => next(snapshot.docs.map((item) => item.data() as Branch)),
    error,
  );
}

export interface RevisionSummary {
  oid: string;
  message: string;
  actorUid: string;
  /** Recorded on commits made after author names were added. */
  authorName?: string | null;
  timestamp: number;
  parent: string[];
  merge?: { sourceBranch: string; targetBranch: string };
}
/** Follow actual parents, rather than treating time ordering as ancestry. */
export async function loadBranchHistory(
  projectId: string,
  head: string,
  count = 50,
): Promise<RevisionSummary[]> {
  const result: RevisionSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = head;
  while (cursor && result.length < count && !seen.has(cursor)) {
    seen.add(cursor);
    const snapshot = await getDoc(
      doc(firebaseDb(), "projects", projectId, "commits", cursor),
    );
    if (!snapshot.exists()) throw new Error("A revision could not be loaded.");
    const revision = { ...snapshot.data(), oid: cursor } as RevisionSummary;
    result.push(revision);
    cursor = revision.parent[0];
  }
  return result;
}

export type InvitationRole = "editor" | "reviewer";
export interface InvitationAccess {
  projectId: string;
  invitationId: string;
  token: string;
}
export interface InvitationInfo {
  title: string;
  ownerName: string;
  role: InvitationRole;
  expiresAt: number;
}
export const getProjectInvitation = (input: InvitationAccess) =>
  call<InvitationInfo>("getProjectInvitation", input);
export const readSharedProject = (
  input: InvitationAccess & { branchId?: string; commitId?: string },
) =>
  call<
    InvitationInfo & {
      draft: Draft;
      commitId: string;
      branchId: string;
      branches: Branch[];
      parent: string[];
    }
  >("readSharedProject", input);
export const updateProjectMemberRole = (
  projectId: string,
  uid: string,
  role: InvitationRole,
) =>
  call<{ updated: boolean }>("updateProjectMemberRole", {
    projectId,
    uid,
    role,
  });
export interface SharedMember {
  uid: string;
  role: Project["role"];
  email?: string;
  displayName?: string;
}
export interface ProjectInvitation {
  id: string;
  email: string;
  role: InvitationRole;
  status: string;
  deliveryStatus?: string;
  expiresAt: number;
}
export function watchSharing(
  projectId: string,
  members: (rows: SharedMember[]) => void,
  invitations: (rows: ProjectInvitation[]) => void,
  error: (error: Error) => void,
) {
  const stopMembers = onSnapshot(
    collection(firebaseDb(), "projects", projectId, "members"),
    (snapshot) => members(snapshot.docs.map((d) => d.data() as SharedMember)),
    error,
  );
  const stopInvites = onSnapshot(
    query(
      collection(firebaseDb(), "projects", projectId, "invitations"),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snapshot) =>
      invitations(
        snapshot.docs.map(
          (d) =>
            ({
              ...d.data(),
              id: d.id,
              expiresAt: d.data().expiresAt.toMillis(),
            }) as ProjectInvitation,
        ),
      ),
    error,
  );
  return () => {
    stopMembers();
    stopInvites();
  };
}

export const readSharedHistory = (input: InvitationAccess, head: string) =>
  call<{ history: RevisionSummary[] }>("readSharedProject", {
    ...input,
    commitId: head,
    history: true,
  }).then((result) => result.history);

/** Matches GRAPH_LIMIT in functions/src/projects/service.ts. */
export const GRAPH_LIMIT = 300;
/** Live commit metadata for the graph: the newest commits across all branches. */
export function watchCommitGraph(
  projectId: string,
  next: (value: RevisionSummary[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(firebaseDb(), "projects", projectId, "commits"),
      orderBy("timestamp", "desc"),
      limit(GRAPH_LIMIT),
    ),
    (snapshot) =>
      next(
        snapshot.docs.map(
          (item) => ({ ...item.data(), oid: item.id }) as RevisionSummary,
        ),
      ),
    error,
  );
}
export const readSharedGraph = (input: InvitationAccess) =>
  call<{ commits: RevisionSummary[] }>("readSharedProject", {
    ...input,
    graph: true,
  }).then((result) => result.commits);
export function watchMembers(
  projectId: string,
  next: (rows: SharedMember[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(firebaseDb(), "projects", projectId, "members"),
    (snapshot) => next(snapshot.docs.map((d) => d.data() as SharedMember)),
    error,
  );
}

export interface MergeRequest {
  id: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  authorUid: string;
  authorName?: string;
  status: "open" | "merged" | "closed";
  mergedCommit?: string;
  mergedByName?: string;
  closedByName?: string;
  createdAt: number;
}
export function watchMergeRequests(
  projectId: string,
  next: (rows: MergeRequest[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(firebaseDb(), "projects", projectId, "mergeRequests"),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snapshot) =>
      next(
        snapshot.docs.map(
          (d) =>
            ({
              ...d.data(),
              id: d.id,
              // Pending server timestamps read as null in latency compensation.
              createdAt: d.data().createdAt?.toMillis?.() ?? Date.now(),
            }) as MergeRequest,
        ),
      ),
    error,
  );
}
export interface MergePreview {
  sourceHead: string;
  targetHead: string;
  baseCommit: string;
  upToDate: boolean;
  fastForward: boolean;
  base: Draft;
  target: Draft;
  source: Draft;
}
export const previewMerge = (
  projectId: string,
  sourceBranch: string,
  targetBranch: string,
) =>
  call<MergePreview>("previewProjectMerge", {
    projectId,
    sourceBranch,
    targetBranch,
  });
export const mergeBranches = (input: {
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  expectedSourceHead: string;
  expectedTargetHead: string;
  resolutions: Record<string, Resolution>;
  message: string;
  mergeRequestId?: string;
  requestId: string;
}) =>
  call<{ commitId: string; branchId: string }>("mergeProjectBranches", input);
export const openMergeRequest = (input: {
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  requestId: string;
}) =>
  call<{ mergeRequestId: string; status: MergeRequest["status"] }>(
    "openMergeRequest",
    input,
  );
export const closeMergeRequest = (projectId: string, mergeRequestId: string) =>
  call<{ closed: boolean }>("closeMergeRequest", {
    projectId,
    mergeRequestId,
  });

/** Upload a draft and wait for the Storage trigger to accept it. */
export async function saveProjectDraft(input: {
  projectId: string;
  branchId: string;
  baseCommit: string;
  expectedVersion: number;
  draft: Draft;
  requestId: string;
}): Promise<UploadResult> {
  const { uploadId } = await uploadProjectDraft(input);
  return new Promise((resolve, reject) => {
    const stop = watchUpload(
      input.projectId,
      uploadId,
      (result) => {
        if (result.status === "awaiting_upload") return;
        stop();
        resolve(result);
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
}
