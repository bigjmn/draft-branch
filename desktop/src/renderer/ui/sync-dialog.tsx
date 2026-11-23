/** Sync with DraftBranch cloud: the header button, the dialog, and the screen
 * that asks about overlapping edits. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChangeList } from "@/components/editor/vc-changes";
import { ConflictList } from "@/components/editor/vc-merge";
import type { Draft } from "@/lib/editor/types";
import { type Resolution, mergeDrafts } from "@/lib/projects/merge";
import type { ConflictRequest, SyncReport } from "../../core/sync/engine";
import {
  type BranchStatus,
  type ProjectStatus,
  projectStatus,
} from "../../core/sync/status";
import type { ProjectRef } from "../../core/types";
import { OPEN_SYNC } from "../platform/events";
import { onChanged } from "../data/projects";
import { projectApi } from "../platform/bridge";
import { useOnline } from "../platform/online";
import {
  describeAttention,
  describeFailure,
  describeReport,
  syncController,
  useSyncView,
} from "../sync/controller";

type Resolutions = Record<string, Resolution>;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function useProjectStatus(projectRef: ProjectRef): ProjectStatus | null {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  useEffect(() => {
    let active = true;
    const api = projectApi(projectRef);
    const load = () =>
      Promise.all([api.state(), api.commits()]).then(
        ([state, commits]) =>
          active && setStatus(projectStatus(state, commits)),
        () => {},
      );
    void load();
    const stop = onChanged(projectRef, () => void load());
    return () => {
      active = false;
      stop();
    };
  }, [projectRef]);
  return status;
}

function when(time: number | undefined): string {
  if (!time) return "not yet";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} hr ago`;
  return new Date(time).toLocaleDateString();
}

/** The control in the editor header. */
export function SyncButton({
  projectRef,
  branch,
  beforeSync,
  revoked = false,
}: {
  projectRef: ProjectRef;
  branch: string;
  /** Resolves true once everything typed is saved; sync may then move this branch. */
  beforeSync?: () => Promise<boolean>;
  revoked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  const view = useSyncView(projectRef);
  const status = useProjectStatus(projectRef);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_SYNC, show);
    return () => window.removeEventListener(OPEN_SYNC, show);
  }, []);
  const up = status
    ? status.unpublishedRevisions + status.unpublishedBranches
    : 0;
  const down = status?.incoming ?? 0;
  const attention = view.report?.attention.length ?? 0;
  const label = view.running
    ? "Syncing…"
    : !online
      ? "Offline"
      : revoked
        ? "Access removed"
        : attention
          ? "Sync needed"
          : up || down
            ? `Sync ${up ? `↑${up}` : ""}${up && down ? " " : ""}${down ? `↓${down}` : ""}`
            : "Synced";
  const tone = view.running
    ? "busy"
    : !online
      ? "offline"
      : attention || up || down
        ? "pending"
        : "ok";
  return (
    <>
      <button
        className="sync-trigger"
        data-tone={tone}
        aria-haspopup="dialog"
        title={
          view.running
            ? view.message
            : !online
              ? "You’re offline. Your work is saved on this device and syncs when you reconnect."
              : up || down
                ? `${up ? plural(up, "change") + " to publish. " : ""}${down ? plural(down, "revision") + " to bring in." : ""}`
                : "Open sync"
        }
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⟳</span> {label}
      </button>
      {open && (
        <SyncDialog
          projectRef={projectRef}
          branch={branch}
          beforeSync={beforeSync}
          onClose={(changed) => {
            setOpen(false);
            // The editor holds this branch in memory; pick up what sync changed.
            if (changed) window.location.reload();
          }}
        />
      )}
    </>
  );
}

const BRANCH_STATE: Record<BranchStatus["state"], (b: BranchStatus) => string> =
  {
    synced: () => "In step with the cloud",
    ahead: (b) => `${plural(b.ahead, "revision")} to publish`,
    behind: (b) => `${plural(b.behind, "revision")} to bring in`,
    diverged: (b) =>
      `${plural(b.ahead, "revision")} here and ${b.behind} in the cloud to combine`,
    new: (b) =>
      b.ahead
        ? `New branch with ${plural(b.ahead, "revision")} to publish`
        : "New branch to publish",
  };

export function SyncDialog({
  projectRef,
  branch,
  beforeSync,
  onClose,
}: {
  projectRef: ProjectRef;
  branch?: string;
  beforeSync?: () => Promise<boolean>;
  /** `changed` is true when sync moved a branch or draft on this device. */
  onClose: (changed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const online = useOnline();
  const status = useProjectStatus(projectRef);
  const view = useSyncView(projectRef);
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [problem, setProblem] = useState("");
  const [lastSynced, setLastSynced] = useState<number | undefined>();
  const [conflict, setConflict] = useState<{
    request: ConflictRequest;
    answer: (value: Resolutions | null) => void;
  } | null>(null);
  const [restart, setRestart] = useState<{
    question: { branch: string; onto: string };
    answer: (value: boolean) => void;
  } | null>(null);
  const changed = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
    void projectApi(projectRef)
      .state()
      .then((state) => setLastSynced(state.meta.cloud?.lastSyncedAt))
      .catch(() => {});
  }, [projectRef]);

  async function run() {
    setPhase("running");
    setProblem("");
    if (beforeSync && !(await beforeSync())) {
      setProblem(
        "Your latest writing is still being saved to this device. Try again in a moment.",
      );
      setPhase("done");
      return;
    }
    // From here the open branch may be moved, so the editor must reload afterwards.
    changed.current = true;
    const result = await syncController.sync(projectRef, {
      focus: branch ? [branch] : undefined,
      moveOpenBranch: true,
      hooks: {
        resolve: (request) =>
          new Promise((answer) => setConflict({ request, answer })),
        restart: (question) =>
          new Promise((answer) => setRestart({ question, answer })),
      },
    });
    changed.current = result.changedLocal;
    setReport(result);
    setLastSynced(result.ok ? Date.now() : lastSynced);
    setPhase("done");
  }
  const close = () => {
    if (phase === "running") return;
    onClose(changed.current);
  };
  const failure = report ? describeFailure(report) : null;
  const done = report ? describeReport(report) : [];
  const earlier = phase === "idle" ? (view.report?.attention ?? []) : [];

  return (
    <dialog
      ref={dialog}
      className={`sync-dialog${conflict ? " wide" : ""}`}
      aria-labelledby="sync-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="sync-heading">
        <div>
          <div className="eyebrow">DRAFTBRANCH CLOUD</div>
          <h2 id="sync-title">Sync this project</h2>
        </div>
        <button
          aria-label="Close sync"
          disabled={phase === "running"}
          onClick={close}
        >
          ×
        </button>
      </div>

      {conflict ? (
        <ConflictResolver
          key={conflict.request.title}
          request={conflict.request}
          onDone={(value) => {
            const { answer } = conflict;
            setConflict(null);
            answer(value);
          }}
        />
      ) : restart ? (
        <div className="sync-question">
          <h3>Bring {restart.question.branch} up to date?</h3>
          <p>
            You started <strong>{restart.question.branch}</strong> from an older
            revision of <strong>{restart.question.onto}</strong>, which has
            moved on in the cloud. To publish it, its revisions are placed on
            top of the latest {restart.question.onto}. Your writing is kept;
            you’re asked about anything that overlaps.
          </p>
          <div className="dialog-actions">
            <button
              onClick={() => {
                restart.answer(false);
                setRestart(null);
              }}
            >
              Not now
            </button>
            <button
              className="primary-action"
              onClick={() => {
                restart.answer(true);
                setRestart(null);
              }}
            >
              Bring it up to date
            </button>
          </div>
        </div>
      ) : phase === "running" ? (
        <p className="sync-progress" role="status">
          <span className="sync-spinner" aria-hidden="true" />
          {view.message || "Syncing…"}
        </p>
      ) : phase === "done" ? (
        <>
          {(problem || failure) && (
            <p className="vc-warning" role="alert">
              {problem || failure}
            </p>
          )}
          {report?.ok && !done.length && !report.attention.length && (
            <p className="sync-result">
              Everything is already in step with the cloud.
            </p>
          )}
          {done.length > 0 && (
            <ul className="sync-result">
              {done.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {report && report.attention.length > 0 && (
            <ul className="sync-attention">
              {report.attention.map((item, index) => (
                <li key={index}>{describeAttention(item)}</li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            {!report?.ok && online && (
              <button onClick={() => void run()}>Try again</button>
            )}
            <button className="primary-action" onClick={close}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sync-lede">
            Sync brings in revisions from the cloud and publishes the revisions
            and branches you made on this device. Last synced {when(lastSynced)}
            .
          </p>
          {status && (
            <ul className="sync-branches">
              {status.branches.map((b) => (
                <li key={b.name} data-state={b.state}>
                  <span className="vc-ref">{b.name}</span>
                  <span>{BRANCH_STATE[b.state](b)}</span>
                </li>
              ))}
              {status.incoming > 0 &&
                !status.branches.some(
                  (b) => b.state === "behind" || b.state === "diverged",
                ) && (
                  <li data-state="behind">
                    <span>
                      {plural(status.incoming, "new cloud revision")} to bring
                      in
                    </span>
                  </li>
                )}
            </ul>
          )}
          {earlier.length > 0 && (
            <ul className="sync-attention">
              {earlier.map((item, index) => (
                <li key={index}>{describeAttention(item)}</li>
              ))}
            </ul>
          )}
          {!online && (
            <p className="vc-warning">
              You’re offline. Keep writing and committing; everything is saved
              on this device and syncs when you reconnect.
            </p>
          )}
          <div className="dialog-actions">
            <button onClick={close}>Close</button>
            <button
              className="primary-action"
              disabled={!online}
              onClick={() => void run()}
            >
              Sync now
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** Settle overlapping edits with the same conflict cards the merge workspace uses. */
function ConflictResolver({
  request,
  onDone,
}: {
  request: ConflictRequest;
  onDone: (value: Resolutions | null) => void;
}) {
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const result = useMemo(
    () =>
      mergeDrafts(request.base, request.target, request.source, resolutions),
    [request, resolutions],
  );
  const drafts = useMemo(
    () => [request.target, request.source] as Draft[],
    [request],
  );
  const unresolved = result.unresolved.length;
  return (
    <div className="sync-conflict">
      <h3>{request.title}</h3>
      <p className="vc-description">{request.description}</p>
      <div className="vc-merge-summary">
        <span className={unresolved ? "conflicted" : "clean"}>
          {unresolved
            ? `${unresolved} of ${result.conflicts.length} conflicts need a decision`
            : `✓ All ${result.conflicts.length} conflicts resolved`}
        </span>
      </div>
      <ConflictList
        conflicts={result.conflicts}
        resolutions={resolutions}
        onChange={setResolutions}
        labels={request.labels}
        disabled={false}
        drafts={drafts}
      />
      <div className="vc-section-title vc-spaced">
        <h3>Result compared with {request.labels.target}</h3>
      </div>
      <ChangeList before={request.target} after={result.draft as Draft} />
      <div className="dialog-actions">
        <button onClick={() => onDone(null)}>Decide later</button>
        <button
          className="primary-action"
          disabled={!!unresolved}
          onClick={() =>
            onDone(
              Object.fromEntries(
                result.conflicts.map((c) => [c.id, resolutions[c.id]]),
              ),
            )
          }
        >
          Use this result
        </button>
      </div>
    </div>
  );
}
