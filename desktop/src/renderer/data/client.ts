/** The project API the shared editor and version-control UI are written
 * against, served from the repository on this device.
 *
 * In the web app, `@/lib/projects/client` talks to Cloud Functions. In the
 * desktop build that import resolves here (see vite.config.ts), so the same
 * components (editor, history graph, diff, merge and "Bring in updates")
 * work with no connection: drafts are saved to disk and revisions are real
 * Git commits in the app's data folder.
 *
 * Collaboration features that only exist on the server (merging the branches of
 * a cloud project, merge requests, sharing) are passed through to the real
 * client. contract.ts checks at compile time that everything the web client
 * exports is offered here with a compatible signature.
 */
import type { Unsubscribe } from "firebase/firestore";
import type { Draft } from "@/lib/editor/types";
import { mergeDrafts } from "@/lib/projects/merge";
import { mergeBase, toGraph } from "../../core/graph";
import { projectStatus } from "../../core/sync/status";
import type {
  CommitInfo,
  ProjectApi,
  ProjectRef,
  ProjectState,
} from "../../core/types";
import { DeviceError } from "../platform/bridge";
import { syncController } from "../sync/controller";
import { firebaseCloud, requireOnline, web } from "./cloud";
import { apiOf, emitChanged, refOf, revisionAuthor, watch } from "./projects";

export type {
  Branch,
  CloudDraft,
  InvitationAccess,
  InvitationInfo,
  InvitationRole,
  MergePreview,
  MergeRequest,
  Operation,
  Project,
  ProjectInvitation,
  RevisionSummary,
  SharedMember,
  UploadResult,
} from "../../../../src/lib/projects/client";
type Branch = web.Branch;
type CloudDraft = web.CloudDraft;
type MergePreview = web.MergePreview;
type MergeRequest = web.MergeRequest;
type Operation = web.Operation;
type RevisionSummary = web.RevisionSummary;
type SharedMember = web.SharedMember;
type UploadResult = web.UploadResult;

export const GRAPH_LIMIT = web.GRAPH_LIMIT;

// Cloud-only features: the same calls the web app makes.
export const createProject = web.createProject;
export const deleteProject = web.deleteProject;
export const watchProjects = web.watchProjects;
// The web app's own type environment (Next.js) treats a request id as a plain
// string, and the shared sharing dialog relies on that.
export const inviteProjectMember = web.inviteProjectMember as (
  projectId: string,
  email: string,
  role: "editor" | "reviewer",
  requestId?: string,
) => ReturnType<typeof web.inviteProjectMember>;
export const acceptProjectInvitation = web.acceptProjectInvitation;
export const removeProjectMember = web.removeProjectMember;
export const revokeProjectInvitation = web.revokeProjectInvitation;
export const updateProjectMemberRole = web.updateProjectMemberRole;
export const watchSharing = web.watchSharing;
export const getProjectInvitation = web.getProjectInvitation;
export const readSharedProject = web.readSharedProject;
export const readSharedHistory = web.readSharedHistory;
export const readSharedGraph = web.readSharedGraph;

const noop: Unsubscribe = () => {};
/** Results of local saves and commits, handed to watchUpload/watchCommit. */
const uploads = new Map<string, UploadResult>();
const operations = new Map<string, Operation>();

interface Project {
  ref: ProjectRef;
  api: ProjectApi;
  state: ProjectState;
  cloud: boolean;
}
async function open(projectId: string): Promise<Project> {
  const ref = refOf(projectId);
  const api = apiOf(projectId);
  const state = await api.state();
  return { ref, api, state, cloud: !!state.meta.cloud };
}
const summary = (commit: CommitInfo): RevisionSummary => ({
  oid: commit.oid,
  message: commit.message,
  // The commit's author key identifies the writer; account ids stay in the cloud.
  actorUid: commit.authorKey,
  authorName: commit.authorName,
  timestamp: commit.timestamp,
  parent: commit.parent,
  ...(commit.merge ? { merge: commit.merge } : {}),
});

/** Read a revision's screenplay, downloading it first if this is a pulled
 * project whose older history has not finished arriving. */
async function snapshotOf(project: Project, commitId: string): Promise<Draft> {
  try {
    return await project.api.readSnapshot(commitId);
  } catch (error) {
    if (
      !(error instanceof DeviceError) ||
      error.code !== "missing-content" ||
      !project.cloud
    )
      throw error;
    if (!navigator.onLine)
      throw new Error(
        "This revision’s text hasn’t been downloaded yet. Connect and sync to read it offline later.",
      );
    const commit = (await project.api.commits()).find(
      (c) => c.oid === commitId,
    );
    const sync = await project.api.syncState();
    const cloudId =
      Object.entries(sync.oidMap).find(
        ([, local]) => local === commitId,
      )?.[0] ?? commitId;
    const draft = await firebaseCloud(project.ref.scope).readRevision(
      project.ref.id,
      cloudId,
    );
    await project.api.writeSnapshot(draft, commit?.blob);
    return project.api.readSnapshot(commitId);
  }
}

// ------------------------------------------------------------------ drafts

export async function loadProjectDraft(
  projectId: string,
  branchId: string,
): Promise<CloudDraft> {
  const project = await open(projectId);
  // Opening a branch needs its head revision's text.
  const head = project.state.branches.find((b) => b.name === branchId)?.head;
  if (head) await snapshotOf(project, head);
  const loaded = await project.api.loadDraft(branchId);
  return {
    draft: loaded.draft,
    version: loaded.version,
    baseCommit: loaded.baseCommit,
    head: loaded.head,
  };
}

type SaveInput = Parameters<typeof web.saveProjectDraft>[0];
async function save(input: SaveInput): Promise<UploadResult> {
  const result = await apiOf(input.projectId).saveDraft({
    branch: input.branchId,
    baseCommit: input.baseCommit,
    expectedVersion: input.expectedVersion,
    draft: input.draft,
  });
  return result;
}
/** Save the working draft to this device. */
export async function saveProjectDraft(
  input: SaveInput,
): Promise<UploadResult> {
  const result = await save(input);
  emitChanged(refOf(input.projectId));
  return result;
}
export async function uploadProjectDraft(
  input: SaveInput,
): Promise<{ uploadId: string }> {
  uploads.set(input.requestId, await save(input));
  return { uploadId: input.requestId };
}
export function watchUpload(
  _projectId: string,
  uploadId: string,
  next: (value: UploadResult) => void,
  error: (error: Error) => void,
): Unsubscribe {
  let active = true;
  queueMicrotask(() => {
    if (!active) return;
    const result = uploads.get(uploadId);
    uploads.delete(uploadId);
    if (result) next(result);
    else error(new Error("The save could not be confirmed."));
  });
  return () => {
    active = false;
  };
}

// ----------------------------------------------------------------- history

export function watchBranches(
  projectId: string,
  next: (value: Branch[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  const api = apiOf(projectId);
  return watch(
    refOf(projectId),
    async () =>
      (await api.state()).branches.map((b) => ({
        name: b.name,
        head: b.head,
        protected: b.protected,
      })),
    next,
    error,
  );
}
async function graph(api: ProjectApi): Promise<RevisionSummary[]> {
  return (await api.commits())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, GRAPH_LIMIT)
    .map(summary);
}
export function watchCommitGraph(
  projectId: string,
  next: (value: RevisionSummary[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  const api = apiOf(projectId);
  return watch(refOf(projectId), () => graph(api), next, error);
}
export async function loadBranchHistory(
  projectId: string,
  head: string,
  count = 50,
): Promise<RevisionSummary[]> {
  const byId = toGraph(await apiOf(projectId).commits());
  const result: RevisionSummary[] = [];
  for (
    let cursor: string | undefined = head;
    cursor && result.length < count;
  ) {
    const commit = byId.get(cursor);
    if (!commit) throw new Error("A revision could not be loaded.");
    result.push(summary(commit));
    cursor = commit.parent[0];
  }
  return result;
}
export async function readProjectRevision(projectId: string, commitId: string) {
  const project = await open(projectId);
  const draft = await snapshotOf(project, commitId);
  const commit = (await project.api.commits()).find((c) => c.oid === commitId);
  return { draft, commitId, parent: commit?.parent ?? [] };
}

/** Commit the saved working draft as a revision on this device. For a pulled
 * project with a connection, watchCommit then publishes it straight away, so
 * committing online behaves as it does on the web. */
export async function commitDraft(
  input: Parameters<typeof web.commitDraft>[0],
) {
  const ref = refOf(input.projectId);
  const result = await apiOf(input.projectId).commit({
    branch: input.branchId,
    expectedHead: input.expectedHead,
    draftVersion: input.draftVersion,
    message: input.message,
    author: { name: await revisionAuthor(ref) },
  });
  if (result.status !== "succeeded")
    throw new Error(result.error ?? "Commit failed. Your draft is preserved.");
  operations.set(input.requestId, {
    status: "succeeded",
    commitId: result.commitId,
  });
  emitChanged(ref);
  return { operationId: input.requestId, status: "queued" as const };
}
export function watchCommit(
  projectId: string,
  operationId: string,
  next: (value: Operation) => void,
  error: (error: Error) => void,
): Unsubscribe {
  let active = true;
  void (async () => {
    const result = operations.get(operationId);
    operations.delete(operationId);
    if (!result) {
      if (active) error(new Error("The revision could not be confirmed."));
      return;
    }
    try {
      const project = await open(projectId);
      // The version-control panel reloads the editor when this resolves, so
      // the open branch may take its published form now.
      if (project.cloud && navigator.onLine)
        await Promise.race([
          syncController.sync(project.ref, { moveOpenBranch: true }),
          new Promise((resolve) => setTimeout(resolve, 30_000)),
        ]);
    } catch {
      /* The revision is safely on this device; publishing waits for the next sync. */
    }
    if (active) next(result);
  })();
  return () => {
    active = false;
  };
}
export async function createBranch(
  projectId: string,
  name: string,
  sourceBranch: string,
  expectedHead: string,
  _requestId?: string,
) {
  const branch = await apiOf(projectId).createBranch({
    name,
    sourceBranch,
    expectedHead,
  });
  emitChanged(refOf(projectId));
  return { branchId: branch.name, head: branch.head };
}

// ------------------------------------------------------------------ merges

const branchOf = (state: ProjectState, name: string) => {
  const branch = state.branches.find((b) => b.name === name);
  if (!branch) throw new Error("Branch not found.");
  return branch;
};
/** Cloud merges need both branches to be exactly what the cloud has. */
async function requirePublished(project: Project, names: string[]) {
  const status = projectStatus(project.state, await project.api.commits());
  for (const name of names) {
    const branch = status.branches.find((b) => b.name === name);
    if (!branch) throw new Error("Branch not found.");
    if (branch.state === "new" || branch.state === "ahead")
      throw new Error(
        `Publish your revisions on ${name} first: close this panel and choose Sync.`,
      );
    if (branch.state !== "synced")
      throw new Error(
        `${name} has newer revisions in the cloud. Close this panel and choose Sync first.`,
      );
  }
}
export async function previewMerge(
  projectId: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<MergePreview> {
  const project = await open(projectId);
  if (sourceBranch === targetBranch)
    throw new Error("Choose two different branches to merge.");
  const source = branchOf(project.state, sourceBranch);
  const target = branchOf(project.state, targetBranch);
  if (project.cloud) {
    // Branches of a cloud project are merged by the server, where the owner's
    // approval of merges into main is enforced.
    requireOnline("Merging the branches of a cloud project");
    await requirePublished(project, [sourceBranch, targetBranch]);
    const preview = await web.previewMerge(
      projectId,
      sourceBranch,
      targetBranch,
    );
    const { oidMap } = await project.api.syncState();
    const local = (oid: string) => oidMap[oid] ?? oid;
    if (
      local(preview.sourceHead) !== source.head ||
      local(preview.targetHead) !== target.head
    )
      throw new Error(
        "These branches changed in the cloud. Close this panel, choose Sync, then merge.",
      );
    return {
      ...preview,
      sourceHead: source.head,
      targetHead: target.head,
      baseCommit: local(preview.baseCommit),
    };
  }
  const base = mergeBase(
    toGraph(await project.api.commits()),
    target.head,
    source.head,
  );
  if (!base) throw new Error("These branches share no history.");
  const [baseDraft, ours, theirs] = await Promise.all(
    [base, target.head, source.head].map((oid) => snapshotOf(project, oid)),
  );
  return {
    sourceHead: source.head,
    targetHead: target.head,
    baseCommit: base,
    upToDate: base === source.head,
    fastForward: base === target.head,
    base: baseDraft,
    target: ours,
    source: theirs,
  };
}
export async function mergeBranches(
  input: Parameters<typeof web.mergeBranches>[0],
) {
  const project = await open(input.projectId);
  if (project.cloud) {
    requireOnline("Merging the branches of a cloud project");
    const remote = (name: string) => {
      const ref = project.state.remotes.find((r) => r.name === name);
      if (!ref)
        throw new Error(
          `Publish ${name} first: close this panel and choose Sync.`,
        );
      return ref.cloudHead;
    };
    const result = await web.mergeBranches({
      ...input,
      expectedSourceHead: remote(input.sourceBranch),
      expectedTargetHead: remote(input.targetBranch),
    });
    // Bring the merge revision down; the panel reloads the editor if needed.
    await syncController.sync(project.ref, { moveOpenBranch: true });
    const { oidMap } = await project.api.syncState();
    return {
      commitId: oidMap[result.commitId] ?? result.commitId,
      branchId: result.branchId,
    };
  }
  const preview = await previewMerge(
    input.projectId,
    input.sourceBranch,
    input.targetBranch,
  );
  if (
    preview.sourceHead !== input.expectedSourceHead ||
    preview.targetHead !== input.expectedTargetHead
  )
    throw new Error("A branch changed. Review the merge again.");
  if (preview.upToDate)
    throw new Error(
      `${input.targetBranch} already contains every revision on ${input.sourceBranch}.`,
    );
  const merged = mergeDrafts(
    preview.base,
    preview.target,
    preview.source,
    input.resolutions,
  );
  if (merged.unresolved.length)
    throw new Error(
      `Resolve ${merged.unresolved.length} conflict${merged.unresolved.length === 1 ? "" : "s"} before merging.`,
    );
  const { oid } = await project.api.mergeCommit({
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    expectedSourceHead: preview.sourceHead,
    expectedTargetHead: preview.targetHead,
    snapshot: { ...merged.draft, schemaVersion: 1 },
    message: input.message,
    author: { name: await revisionAuthor(project.ref) },
  });
  emitChanged(project.ref);
  return { commitId: oid, branchId: input.targetBranch };
}

export async function openMergeRequest(
  input: Parameters<typeof web.openMergeRequest>[0],
) {
  const project = await open(input.projectId);
  if (!project.cloud)
    throw new Error("Merge requests belong to projects in DraftBranch cloud.");
  requireOnline("Opening a merge request");
  await requirePublished(project, [input.sourceBranch, input.targetBranch]);
  return web.openMergeRequest(input);
}
export async function closeMergeRequest(
  projectId: string,
  mergeRequestId: string,
) {
  requireOnline("Closing a merge request");
  return web.closeMergeRequest(projectId, mergeRequestId);
}

/** Live cloud data for a pulled project; nothing for one kept only on this device. */
function whenCloud<T>(
  projectId: string,
  next: (rows: T[]) => void,
  error: (error: Error) => void,
  start: () => Unsubscribe,
): Unsubscribe {
  let stop: Unsubscribe = noop;
  let active = true;
  open(projectId).then(
    (project) => {
      if (!active) return;
      if (project.cloud && project.state.meta.cloud?.access === "ok")
        stop = start();
      else next([]);
    },
    (problem) =>
      active &&
      error(problem instanceof Error ? problem : new Error(String(problem))),
  );
  return () => {
    active = false;
    stop();
  };
}
export function watchMergeRequests(
  projectId: string,
  next: (rows: MergeRequest[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return whenCloud(projectId, next, error, () =>
    web.watchMergeRequests(projectId, next, error),
  );
}
export function watchMembers(
  projectId: string,
  next: (rows: SharedMember[]) => void,
  error: (error: Error) => void,
): Unsubscribe {
  return whenCloud(projectId, next, error, () =>
    web.watchMembers(projectId, next, error),
  );
}

// ----------------------------------------------------------------- project

/** Rename the project. For a pulled project the owner's rename also goes to
 * the cloud, now or (when offline) with the next sync. */
export async function renameProject(projectId: string, title: string) {
  const project = await open(projectId);
  if (!project.cloud) {
    await project.api.setMeta({ title });
  } else {
    let sent = false;
    if (navigator.onLine)
      try {
        await web.renameProject(projectId, title);
        sent = true;
      } catch {
        /* Keep it for the next sync. */
      }
    await project.api.setMeta({
      title,
      cloud: { pendingTitle: sent ? "" : title },
    });
  }
  emitChanged(project.ref);
  return { title };
}
