/** DraftBranch cloud, reached exactly as the web app reaches it: the same
 * callable Cloud Functions and the same membership-checked Firestore reads.
 * Nothing here needs a backend change. */
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
} from "firebase/firestore";
import { firebaseAuth, firebaseDb } from "@/lib/firebase/client";
// The web app's own client. Imported by path so it is the real one, not the
// on-device implementation the "@/lib/projects/client" alias points to here.
import * as web from "../../../../src/lib/projects/client";
import { authorName, parseSnapshot } from "../../core/snapshot";
import {
  type CloudApi,
  type CloudCommit,
  CloudError,
} from "../../core/sync/cloud";
import type { CommitResult, Role, SaveResult } from "../../core/types";

export { web };

const CALL_TIMEOUT_MS = 45_000;
const COMMIT_TIMEOUT_MS = 120_000;
const ROLES: Role[] = ["owner", "editor", "commenter", "reviewer"];

const codeOf = (error: unknown): string =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code).replace(/^functions\//, "")
    : "";
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Turn Firebase's errors into the few kinds sync cares about. */
export function cloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const code = codeOf(error);
  if (
    !navigator.onLine ||
    [
      "unavailable",
      "deadline-exceeded",
      "auth/network-request-failed",
      "storage/retry-limit-exceeded",
    ].includes(code)
  )
    return new CloudError(
      "offline",
      "DraftBranch cloud can’t be reached right now.",
    );
  if (["permission-denied", "unauthenticated"].includes(code))
    return new CloudError(
      "denied",
      messageOf(error, "Project access is not permitted."),
    );
  if (code === "not-found")
    return new CloudError("not-found", messageOf(error, "Not found."));
  // A callable that never got a response surfaces as "internal".
  if (code === "internal")
    return new CloudError(
      "other",
      "DraftBranch cloud didn’t respond. Check your connection and try again.",
    );
  return new CloudError(
    "other",
    messageOf(error, "DraftBranch cloud reported a problem."),
  );
}
/** Firestore can wait a long time before deciding it is offline; don't. */
function timed<T>(work: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new CloudError(
            "offline",
            "DraftBranch cloud took too long to answer.",
          ),
        ),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(cloudError(error));
      },
    );
  });
}
export function requireOnline(what: string) {
  if (!navigator.onLine)
    throw new Error(
      `You’re offline. ${what} needs a connection to DraftBranch cloud.`,
    );
}

function commitFrom(id: string, data: Record<string, unknown>): CloudCommit {
  const merge = data.merge as
    { sourceBranch?: unknown; targetBranch?: unknown } | undefined;
  return {
    oid: id,
    tree: String(data.tree),
    blob: String(data.blob),
    parent: Array.isArray(data.parent) ? data.parent.map(String) : [],
    message: String(data.message ?? ""),
    actorUid: String(data.actorUid ?? ""),
    authorName: typeof data.authorName === "string" ? data.authorName : null,
    timestamp: Number(data.timestamp ?? 0),
    ...(merge &&
    typeof merge.sourceBranch === "string" &&
    typeof merge.targetBranch === "string"
      ? {
          merge: {
            sourceBranch: merge.sourceBranch,
            targetBranch: merge.targetBranch,
          },
        }
      : {}),
  };
}

export function firebaseCloud(uid: string): CloudApi {
  const project = (projectId: string) =>
    doc(firebaseDb(), "projects", projectId);
  const within = (projectId: string, name: string) =>
    collection(firebaseDb(), "projects", projectId, name);
  return {
    uid,
    async access(projectId) {
      const read = async () => {
        const [projectDoc, member] = await timed(
          Promise.all([
            getDocFromServer(project(projectId)),
            getDocFromServer(doc(within(projectId, "members"), uid)),
          ]),
        );
        const role = member.data()?.role as Role | undefined;
        if (
          !projectDoc.exists() ||
          projectDoc.data().deleting ||
          !role ||
          !ROLES.includes(role)
        )
          return null;
        const options = member.data()?.access;
        return {
          title: String(projectDoc.data().title ?? "Untitled screenplay"),
          role,
          ...(role === "editor" && options && typeof options === "object"
            ? {
                options: {
                  editMain: options.editMain === true,
                  commentMain: options.commentMain !== false,
                  branch:
                    typeof options.branch === "string" ? options.branch : null,
                },
              }
            : {}),
        };
      };
      try {
        return await read();
      } catch (error) {
        if (cloudError(error).kind !== "denied") throw cloudError(error);
      }
      // Firestore rules answer "denied" for non-members and for projects that
      // are gone, but also for a stale sign-in. Refresh the session and ask
      // once more before concluding that access was removed.
      try {
        await timed(
          firebaseAuth().currentUser?.getIdToken(true) ?? Promise.resolve(""),
        );
        return await read();
      } catch (error) {
        if (cloudError(error).kind === "denied") return null;
        throw cloudError(error);
      }
    },
    async branches(projectId) {
      const rows = await timed(
        getDocsFromServer(within(projectId, "branches")),
      );
      return rows.docs.map((row) => ({
        name: String(row.data().name ?? row.id),
        head: String(row.data().head),
        protected: row.data().protected === true,
        createdBy: (row.data().createdBy as string | undefined) ?? null,
        dedicatedTo: (row.data().dedicatedTo as string | undefined) ?? null,
      }));
    },
    async commits(projectId) {
      const rows = await timed(getDocsFromServer(within(projectId, "commits")));
      return rows.docs.map((row) => commitFrom(row.id, row.data()));
    },
    async commit(projectId, oid) {
      const row = await timed(
        getDocFromServer(doc(within(projectId, "commits"), oid)),
      );
      return row.exists() ? commitFrom(row.id, row.data()) : null;
    },
    async memberNames(projectId) {
      const rows = await timed(getDocsFromServer(within(projectId, "members")));
      const names: Record<string, string[]> = {};
      for (const row of rows.docs) {
        const { displayName, email } = row.data() as {
          displayName?: string;
          email?: string;
        };
        names[row.id] = [
          authorName(displayName, ""),
          email?.split("@")[0]?.slice(0, 100) ?? "",
        ].filter(Boolean);
      }
      return names;
    },
    async readRevision(projectId, oid) {
      return (await timed(web.readProjectRevision(projectId, oid))).draft;
    },
    loadDraft: (projectId, branch) =>
      timed(web.loadProjectDraft(projectId, branch)),
    async saveDraft(input): Promise<SaveResult> {
      try {
        // Uploads the JSON through a server-issued ticket and waits for the
        // backend to validate and accept it.
        const result = await timed(
          web.saveProjectDraft({ ...input, draft: parseSnapshot(input.draft) }),
          COMMIT_TIMEOUT_MS,
        );
        return result.status === "awaiting_upload"
          ? { status: "rejected", error: "The cloud did not confirm the save." }
          : {
              status: result.status,
              version: result.version,
              error: result.error,
            };
      } catch (error) {
        if (codeOf(error) === "aborted")
          return {
            status: "conflict",
            error: messageOf(error, "The cloud draft changed."),
          };
        throw cloudError(error);
      }
    },
    async commitDraft(input): Promise<CommitResult> {
      try {
        const job = await timed(web.commitDraft(input));
        return await new Promise<CommitResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            stop();
            reject(
              new CloudError(
                "other",
                "The cloud did not confirm the revision in time.",
              ),
            );
          }, COMMIT_TIMEOUT_MS);
          const stop = web.watchCommit(
            input.projectId,
            job.operationId,
            (result) => {
              if (result.status === "queued") return;
              clearTimeout(timer);
              stop();
              resolve({
                status: result.status,
                commitId: result.commitId,
                error: result.error,
              });
            },
            (error) => {
              clearTimeout(timer);
              stop();
              reject(cloudError(error));
            },
          );
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "aborted")
          return {
            status: "conflict",
            error: messageOf(error, "The branch changed in the cloud."),
          };
        if (code === "failed-precondition" || code === "permission-denied")
          return {
            status: "rejected",
            error: messageOf(error, "The cloud refused this revision."),
          };
        throw cloudError(error);
      }
    },
    async createBranch(input) {
      await timed(
        web.createBranch(
          input.projectId,
          input.name,
          input.sourceBranch,
          input.expectedHead,
          input.requestId as ReturnType<typeof crypto.randomUUID>,
        ),
      );
    },
    async renameProject(projectId, title) {
      await timed(web.renameProject(projectId, title));
    },
  };
}
