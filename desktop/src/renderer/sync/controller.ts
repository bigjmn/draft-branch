/** Runs sync for the app: one run per project at a time, progress for the UI,
 * and the rule that a branch open in the editor is not moved underneath it. */
import { useSyncExternalStore } from "react";
import { firebaseAuth } from "@/lib/firebase/client";
import {
  type Attention,
  type SyncHooks,
  SyncInterrupted,
  type SyncReport,
  syncProject,
} from "../../core/sync/engine";
import type { ProjectApi, ProjectRef, Role } from "../../core/types";
import { firebaseCloud } from "../data/cloud";
import { emitChanged, keyOf } from "../data/projects";
import { device, projectApi } from "../platform/bridge";

export interface SyncView {
  running: boolean;
  message: string;
  report: SyncReport | null;
  finishedAt: number | null;
}
const IDLE: SyncView = {
  running: false,
  message: "",
  report: null,
  finishedAt: null,
};

export interface SyncRequest {
  /** Branches whose cloud working draft should be checked even with no draft here. */
  focus?: string[];
  allDrafts?: boolean;
  /** Present for a sync the writer is watching; lets it ask questions. */
  hooks?: Pick<SyncHooks, "resolve" | "restart">;
  /** The caller will reload the editor afterwards, so the open branch may move. */
  moveOpenBranch?: boolean;
}

function blankReport(patch: Partial<SyncReport>): SyncReport {
  return {
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
    ...patch,
  };
}

class SyncController {
  private readonly views = new Map<string, SyncView>();
  private readonly queue = new Map<string, Promise<SyncReport>>();
  private readonly pending = new Map<string, number>();
  private readonly holds = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  view(ref: ProjectRef | null): SyncView {
    return (ref && this.views.get(keyOf(ref))) || IDLE;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(key: string, patch: Partial<SyncView>) {
    this.views.set(key, { ...(this.views.get(key) ?? IDLE), ...patch });
    for (const listener of this.listeners) listener();
  }

  /** Mark a branch as open in an editor. Returns the function that releases it. */
  hold(ref: ProjectRef, branch: string): () => void {
    const key = keyOf(ref);
    this.holds.set(key, branch);
    return () => {
      if (this.holds.get(key) === branch) this.holds.delete(key);
    };
  }

  sync(ref: ProjectRef, request: SyncRequest = {}): Promise<SyncReport> {
    const key = keyOf(ref);
    const tail = this.queue.get(key);
    // A background request rides along with whatever is already under way.
    if (
      tail &&
      this.pending.get(key) &&
      !request.hooks &&
      !request.moveOpenBranch
    )
      return tail;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    const run = (tail ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.execute(ref, request))
      .finally(() => this.pending.set(key, (this.pending.get(key) ?? 1) - 1));
    this.queue.set(key, run);
    return run;
  }

  private async execute(
    ref: ProjectRef,
    request: SyncRequest,
  ): Promise<SyncReport> {
    const key = keyOf(ref);
    const user = firebaseAuth().currentUser;
    const done = (report: SyncReport) => {
      this.set(key, {
        running: false,
        message: "",
        report,
        finishedAt: Date.now(),
      });
      emitChanged(ref);
      return report;
    };
    if (!user || user.isAnonymous || user.uid !== ref.scope)
      return done(
        blankReport({
          error: "Sign in to the account that pulled this project to sync it.",
        }),
      );
    if (!navigator.onLine) return done(blankReport({ offline: true }));
    this.set(key, { running: true, message: "Starting sync" });
    const api = projectApi(ref);
    try {
      return done(
        await syncProject(
          firebaseCloud(user.uid),
          request.moveOpenBranch ? api : this.guarded(key, api),
          {
            hold: request.moveOpenBranch
              ? null
              : () => this.holds.get(key) ?? null,
            focus: request.focus,
            allDrafts: request.allDrafts,
            hooks: {
              ...request.hooks,
              progress: (message) => this.set(key, { running: true, message }),
            },
          },
        ),
      );
    } catch (error) {
      return done(
        blankReport({
          error: error instanceof Error ? error.message : "Sync failed.",
        }),
      );
    }
  }

  /** Sync asks before touching the open branch, but an editor can open
   * between the question and the change. This is the hard stop: once a branch
   * is held, a change to its head or draft is refused before it is sent.
   * Anything sent earlier is applied before the editor's own reads, because
   * the main process handles a project's requests in order. */
  private guarded(key: string, api: ProjectApi): ProjectApi {
    const held = () => this.holds.get(key);
    return new Proxy(api, {
      get: (target, method: keyof ProjectApi) => {
        if (method === "updateRefs")
          return (update: Parameters<ProjectApi["updateRefs"]>[0]) => {
            const change = held() ? update.branches?.[held()!] : undefined;
            if (change && change.head !== change.expected)
              throw new SyncInterrupted();
            return target.updateRefs(update);
          };
        if (method === "setDraft")
          return (input: Parameters<ProjectApi["setDraft"]>[0]) => {
            if (input.branch === held()) throw new SyncInterrupted();
            return target.setDraft(input);
          };
        return target[method];
      },
    });
  }

  /** Bring a cloud project onto this device for the first time. */
  async pull(project: {
    projectId: string;
    title: string;
    role: Role;
  }): Promise<SyncReport> {
    const user = firebaseAuth().currentUser;
    if (!user || user.isAnonymous)
      return blankReport({ error: "Sign in to pull projects." });
    await device({
      kind: "library.createClone",
      input: {
        uid: user.uid,
        projectId: project.projectId,
        title: project.title,
        role: project.role,
      },
    });
    return this.sync(
      { scope: user.uid, id: project.projectId },
      { allDrafts: true, moveOpenBranch: true },
    );
  }
}
export const syncController = new SyncController();

export function useSyncView(ref: ProjectRef | null): SyncView {
  const key = ref ? keyOf(ref) : "";
  return useSyncExternalStore(syncController.subscribe, () =>
    key ? syncController.view(ref) : IDLE,
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a finished sync did, in the product's words. */
export function describeReport(report: SyncReport): string[] {
  const lines: string[] = [];
  const published = Object.entries(report.published);
  if (report.fetched)
    lines.push(
      `Brought in ${plural(report.fetched, "revision")} from the cloud.`,
    );
  for (const name of report.createdBranches)
    lines.push(`Added branch ${name}.`);
  for (const name of report.fastForwarded)
    lines.push(`${name} is up to date with the cloud.`);
  for (const name of report.replayed)
    lines.push(
      `Combined your revisions on ${name} with newer cloud revisions.`,
    );
  for (const name of report.publishedBranches)
    lines.push(`Published branch ${name}.`);
  for (const [name, count] of published)
    lines.push(`Published ${plural(count, "revision")} on ${name}.`);
  for (const name of report.draftsPulled)
    lines.push(`Brought in your working draft on ${name}.`);
  for (const name of report.draftsMerged)
    lines.push(
      `Combined your working draft on ${name} with the one in the cloud.`,
    );
  for (const name of report.draftsPushed)
    lines.push(`Saved your working draft on ${name} to the cloud.`);
  if (report.contentPending)
    lines.push(
      `${plural(report.contentPending, "older revision")} will finish downloading on the next sync.`,
    );
  return lines;
}
export function describeAttention(item: Attention): string {
  switch (item.kind) {
    case "updates":
      return `${item.branch} has ${plural(item.count, "new revision")} in the cloud. Sync to bring ${item.count === 1 ? "it" : "them"} in.`;
    case "diverged":
      return `${item.branch} changed both here and in the cloud. Sync to combine the two.`;
    case "pending":
      return `${plural(item.count, "revision")} on ${item.branch} ${item.count === 1 ? "is" : "are"} waiting to be published.`;
    case "draft":
      return `Your working draft on ${item.branch} changed here and on the web. Sync to combine them.`;
    case "stale-branch":
      return `Branch ${item.branch} starts from an older revision and can’t be published as it is. Sync to bring it up to date.`;
    case "forbidden":
      return item.message;
    case "failed":
      return item.branch ? `${item.branch}: ${item.message}` : item.message;
  }
}
/** One line for a sync that could not run or stopped early. */
export function describeFailure(report: SyncReport): string | null {
  if (report.access === "revoked")
    return "This account no longer has access to the project in the cloud. The copy on this device is now read-only.";
  if (report.offline)
    return "You’re offline. Your work is saved on this device and will sync when you reconnect.";
  if (report.error) return report.error;
  return null;
}
