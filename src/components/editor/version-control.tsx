"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  readSharedProject,
  readSharedGraph,
  createBranch,
  commitDraft,
  readProjectRevision,
  watchBranches,
  watchCommit,
  watchCommitGraph,
  watchMembers,
  watchMergeRequests,
  type Branch,
  type MergeRequest,
  type RevisionSummary,
  type SharedMember,
} from "@/lib/projects/client";
import { draftChanges } from "@/lib/projects/changes";
import { aheadBehind, orderCommits, reachable } from "@/lib/projects/graph";
import type { Draft } from "@/lib/editor/types";
import type { EditorProject } from "./use-project-draft";
import type { ReaderOptions } from "./screenplay-editor";
import { ChangeList } from "./vc-changes";
import { CommitGraph, authorBadge } from "./vc-graph";
import { MergeWorkspace, UpdateWorkspace } from "./vc-merge";

/** Wording and extras for shells where the draft is not saved to the cloud
 * (the desktop app). Every field falls back to the web app's behaviour. */
export interface VersionControlOptions {
  savedLabel?: string;
  savingLabel?: string;
  repositoryLabel?: string;
  /** False where merge requests do not exist, e.g. a project with no cloud. */
  mergeRequests?: boolean;
  /** A short tag beside a revision in the graph, such as "not published". */
  revisionTag?: (commit: RevisionSummary) => string | undefined;
  /** Commit wording where a revision is not published as it is committed. */
  commitLabels?: { busy: string; progress: string; done: string };
}
interface Props {
  readOnly?: boolean;
  reader?: ReaderOptions;
  project?: EditorProject;
  draft: Draft;
  saved: boolean;
  getVersion?: () => number;
  canPublish?: () => boolean;
  options?: VersionControlOptions;
}
type View = "graph" | "working" | "merge" | "request" | "update";
const DEFAULT_BRANCH = "main";

export function VersionControl(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="version-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">⑂</span> Version control
      </button>
      {open && <VersionPanel {...props} close={() => setOpen(false)} />}
    </>
  );
}

function VersionPanel({
  readOnly = false,
  reader,
  project,
  draft,
  saved,
  getVersion,
  canPublish,
  options,
  close,
}: Props & { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commits, setCommits] = useState<RevisionSummary[] | null>(null);
  const [members, setMembers] = useState<SharedMember[]>([]);
  const [requests, setRequests] = useState<MergeRequest[]>([]);
  const [view, setView] = useState<View>(readOnly ? "graph" : "working");
  const [scope, setScope] = useState<string | null>(null);
  const [selected, setSelected] = useState<RevisionSummary | null>(null);
  const [comparison, setComparison] = useState<{
    before: Draft;
    after: Draft;
  } | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [route, setRoute] = useState({ source: "", target: DEFAULT_BRANCH });
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const stop = useRef<(() => void) | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    ref.current?.showModal();
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current?.();
    };
  }, []);
  const access = reader?.access;
  const readRevision = (projectId: string, commitId: string) =>
    access
      ? readSharedProject({ ...access, commitId })
      : readProjectRevision(projectId, commitId);
  useEffect(() => {
    if (reader?.branches) setBranches(reader.branches);
  }, [reader?.branches]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    const offline = () =>
      setError("Couldn’t load project history. Check your connection.");
    const stops = access
      ? []
      : [
          watchBranches(project.id, setBranches, offline),
          watchCommitGraph(project.id, setCommits, offline),
          watchMembers(project.id, setMembers, () => setMembers([])),
          watchMergeRequests(project.id, setRequests, () => setRequests([])),
        ];
    if (access)
      readSharedGraph(access)
        .then((rows) => active && setCommits(rows))
        .catch(() => active && offline());
    readRevision(project.id, project.initial.baseCommit)
      .then((r) => {
        if (active) setBase(r.draft);
      })
      .catch(() => {
        if (active) setError("Couldn’t load the base revision.");
      });
    return () => {
      active = false;
      stops.forEach((s) => s());
    };
    // Subscriptions belong to this project and base revision only.
  }, [project?.id, project?.initial.baseCommit]);
  useEffect(() => {
    if (!project || !selected) return;
    let active = true;
    setComparison(null);
    Promise.all([
      readRevision(project.id, selected.oid),
      selected.parent[0]
        ? readRevision(project.id, selected.parent[0])
        : Promise.resolve({ draft: { title: "", blocks: [] } as Draft }),
    ])
      .then(([after, before]) => {
        if (active) setComparison({ before: before.draft, after: after.draft });
      })
      .catch(() => {
        if (active) setError("Couldn’t load revision details.");
      });
    return () => {
      active = false;
    };
  }, [project?.id, selected?.oid]);

  const current = branches.find((b) => b.name === project?.branch);
  const stale = !!current && current.head !== project?.initial.baseCommit;
  const working = useMemo(
    () => (base ? draftChanges(base, draft) : null),
    [base, draft],
  );
  const revisionChanges = useMemo(
    () =>
      comparison ? draftChanges(comparison.before, comparison.after) : null,
    [comparison],
  );
  const byId = useMemo(
    () => new Map((commits ?? []).map((c) => [c.oid, c])),
    [commits],
  );
  const ordered = useMemo(() => orderCommits(commits ?? []), [commits]);
  const scopeHead = branches.find((b) => b.name === scope)?.head;
  const visible = useMemo(() => {
    if (!scope) return ordered;
    const keep = reachable(byId, scopeHead);
    return ordered.filter((c) => keep.has(c.oid));
  }, [ordered, byId, scope, scopeHead]);
  const sortedBranches = useMemo(
    () =>
      [...branches].sort((a, b) =>
        a.name === DEFAULT_BRANCH
          ? -1
          : b.name === DEFAULT_BRANCH
            ? 1
            : a.name.localeCompare(b.name),
      ),
    [branches],
  );
  const mainHead = branches.find((b) => b.name === DEFAULT_BRANCH)?.head;
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.uid, m])),
    [members],
  );
  const author = (commit: RevisionSummary) => {
    const member = memberById.get(commit.actorUid);
    const name =
      commit.authorName ||
      member?.displayName ||
      member?.email?.split("@")[0] ||
      (commit.actorUid === project?.uid ? "You" : "Writer");
    return authorBadge(commit.actorUid, name);
  };
  const openRequests = requests.filter((r) => r.status === "open");
  const activeRequest = requests.find((r) => r.id === requestId);

  const ready = readOnly || (saved && !!canPublish?.());
  const canCommit =
    !readOnly &&
    !!project &&
    ready &&
    !!base &&
    !!working?.length &&
    !stale &&
    !!current &&
    (!current.protected || project.role === "owner") &&
    !busy;
  const writer =
    !readOnly && (project?.role === "owner" || project?.role === "editor");

  function navigate(name: string) {
    if (busy) return;
    if (readOnly) {
      if (reader?.onBranchChange) {
        reader.onBranchChange(name);
        close();
        return;
      }
    } else if (!ready || !canPublish?.()) return;
    window.location.assign(
      `/editor?project=${encodeURIComponent(project!.id)}&branch=${encodeURIComponent(name)}`,
    );
  }
  function startMerge(source: string) {
    const fallback =
      source === DEFAULT_BRANCH
        ? project?.branch !== DEFAULT_BRANCH
          ? project!.branch
          : sortedBranches.find((b) => b.name !== DEFAULT_BRANCH)?.name
        : DEFAULT_BRANCH;
    setRoute({ source, target: fallback ?? DEFAULT_BRANCH });
    setRequestId(null);
    setError("");
    setNotice("");
    setView("merge");
  }
  function openRequest(id: string) {
    setRequestId(id);
    setError("");
    setNotice("");
    setView("request");
  }
  function merged(target: string) {
    if (target === project?.branch) {
      setNotice(`Merged into ${target}. Reopening your draft…`);
      // A clean draft follows the new head on reload; uncommitted writing
      // stays put and offers "Bring in updates".
      window.location.reload();
      return;
    }
    setNotice(`Merged into ${target}.`);
    setScope(target);
    setSelected(null);
    setView("graph");
  }
  async function publish() {
    if (!canCommit || !message.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice(options?.commitLabels?.progress ?? "Publishing revision…");
    const input = {
      projectId: project!.id,
      branchId: project!.branch,
      expectedHead: current!.head,
      draftVersion: getVersion!(),
      message: message.trim(),
    };
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const job = await commitDraft({
        ...input,
        requestId: request.current.id,
      });
      if (!mounted.current) return;
      stop.current = watchCommit(
        project!.id,
        job.operationId,
        (result) => {
          if (result.status === "queued") return;
          stop.current?.();
          if (result.status === "succeeded") {
            setNotice(
              options?.commitLabels?.done ??
                "Revision published. Reopening your draft…",
            );
            window.location.reload();
          } else {
            setBusy(false);
            lock.current = false;
            setNotice("");
            setError(
              result.error ||
                "The branch changed. Your draft is preserved; bring in updates before committing.",
            );
          }
        },
        () => {
          setBusy(false);
          lock.current = false;
          setNotice("");
          setError(
            "Couldn’t confirm the commit. Retry the same message to check the original operation.",
          );
        },
      );
    } catch (e) {
      if (mounted.current) {
        setBusy(false);
        lock.current = false;
        setNotice("");
        setError(
          e instanceof Error
            ? e.message
            : "Commit failed. Your draft is preserved.",
        );
      }
    }
  }
  async function branch() {
    const from = scope ?? project?.branch ?? DEFAULT_BRANCH;
    const source = branches.find((b) => b.name === from);
    if (
      readOnly ||
      !project ||
      !source ||
      !ready ||
      lock.current ||
      !canPublish?.()
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await createBranch(project.id, branchName, from, source.head);
      if (mounted.current)
        window.location.assign(
          `/editor?project=${encodeURIComponent(project.id)}&branch=${encodeURIComponent(branchName)}`,
        );
    } catch (e) {
      if (mounted.current) {
        setBusy(false);
        lock.current = false;
        setError(e instanceof Error ? e.message : "Branch creation failed.");
      }
    }
  }
  return (
    <dialog
      ref={ref}
      className="version-panel"
      aria-labelledby="version-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="vc-heading">
        <div>
          <div className="eyebrow">PROJECT HISTORY</div>
          <h2 id="version-title">Version control</h2>
        </div>
        <span className="vc-private">
          {options?.repositoryLabel ?? "Private repository"}
        </span>
        <button
          className="vc-close"
          aria-label="Close version control"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      {!project ? (
        <div className="vc-guest">
          <span aria-hidden="true">⑂</span>
          <h3>Give your story a history.</h3>
          <p>
            Sign in and create a project to save named revisions, explore
            alternate branches, and share your work.
          </p>
          <p>
            Your guest draft stays on this device. Export it before leaving.
          </p>
          <a className="primary-action" href="/">
            Sign in to create a project
          </a>
        </div>
      ) : (
        <>
          <div className="vc-toolbar">
            <span className="vc-checkout">
              ⑂ <strong>{project.branch}</strong>
              <small>checked out</small>
            </span>
            <button
              disabled={readOnly || !ready || busy}
              title={
                readOnly ? "Read-only access cannot create branches" : undefined
              }
              onClick={() => setCreating(!creating)}
            >
              ⑂ New branch
            </button>
            {!access && (
              <button
                disabled={busy || branches.length < 2}
                title={
                  branches.length < 2
                    ? "Create a branch first"
                    : "Merge one branch into another"
                }
                onClick={() =>
                  startMerge(
                    project.branch !== DEFAULT_BRANCH
                      ? project.branch
                      : (sortedBranches.find((b) => b.name !== DEFAULT_BRANCH)
                          ?.name ?? DEFAULT_BRANCH),
                  )
                }
              >
                ⇄ Merge
              </button>
            )}
            <span className="vc-sync">
              {readOnly
                ? "Read-only access"
                : saved
                  ? (options?.savedLabel ?? "Cloud draft saved")
                  : (options?.savingLabel ?? "Waiting for cloud save…")}
            </span>
          </div>
          {creating && !readOnly && (
            <form
              className="vc-branch-form"
              onSubmit={(e) => {
                e.preventDefault();
                void branch();
              }}
            >
              <label>
                Branch from {scope ?? project.branch}
                <input
                  autoFocus
                  aria-label="New branch name"
                  placeholder="alternate-ending"
                  value={branchName}
                  maxLength={64}
                  pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
                  required
                  disabled={busy}
                  onChange={(e) => setBranchName(e.target.value)}
                />
              </label>
              <p>
                Starts from the latest committed revision. Uncommitted writing
                stays on {project.branch}.
              </p>
              <button
                className="primary-action"
                disabled={!ready || busy || !branchName}
              >
                Create & switch
              </button>
            </form>
          )}
          {error && (
            <p className="vc-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="vc-notice" role="status">
              {notice}
            </p>
          )}
          <div className="vc-body">
            <nav className="vc-sidebar" aria-label="Version navigation">
              <div className="eyebrow">WORKSPACE</div>
              {!readOnly && (
                <button
                  aria-pressed={view === "working" || view === "update"}
                  onClick={() => {
                    setView("working");
                    setSelected(null);
                  }}
                >
                  <span>◉ Uncommitted changes</span>
                  {!!working?.length && <small>{working.length}</small>}
                </button>
              )}
              <button
                aria-pressed={view === "graph" && scope === null}
                onClick={() => {
                  setView("graph");
                  setScope(null);
                }}
              >
                <span>◷ All branches</span>
              </button>
              <div className="eyebrow vc-branch-heading">
                LOCAL BRANCHES <span>{branches.length}</span>
              </div>
              {sortedBranches.map((b) => {
                const counts =
                  mainHead && b.name !== DEFAULT_BRANCH && commits
                    ? aheadBehind(byId, b.head, mainHead)
                    : null;
                return (
                  <button
                    className="vc-branch"
                    key={b.name}
                    aria-pressed={scope === b.name && view === "graph"}
                    onClick={() => {
                      setScope(b.name);
                      setView("graph");
                      setSelected(null);
                    }}
                  >
                    <span className="vc-branch-name">
                      {b.protected ? "🔒" : "⑂"} {b.name}
                    </span>
                    <span className="vc-branch-meta">
                      {counts && counts.ahead > 0 && (
                        <span className="ahead" title="Revisions not on main">
                          ↑{counts.ahead}
                        </span>
                      )}
                      {counts && counts.behind > 0 && (
                        <span
                          className="behind"
                          title="Main revisions not here"
                        >
                          ↓{counts.behind}
                        </span>
                      )}
                      {b.name === project.branch && (
                        <span className="vc-ref head">HEAD</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {!access && options?.mergeRequests !== false && (
                <>
                  <div className="eyebrow vc-branch-heading">
                    MERGE REQUESTS <span>{openRequests.length}</span>
                  </div>
                  {requests.slice(0, 12).map((r) => (
                    <button
                      key={r.id}
                      className="vc-request"
                      aria-pressed={view === "request" && requestId === r.id}
                      onClick={() => openRequest(r.id)}
                    >
                      <span>
                        <span className={`vc-mr-dot ${r.status}`} /> {r.title}
                      </span>
                      <small>
                        {r.sourceBranch} → {r.targetBranch}
                      </small>
                    </button>
                  ))}
                  {!requests.length && (
                    <p className="vc-sidebar-empty">No merge requests yet.</p>
                  )}
                </>
              )}
              <p className="vc-sidebar-note">
                {readOnly
                  ? "Browse every committed branch, revision and merge request. Changes require Editor access."
                  : project.role === "owner"
                    ? "You own this project: merges into main are yours to approve."
                    : "Editors merge into their own branches and open merge requests for main. The owner approves them."}
              </p>
            </nav>
            <section
              className={`vc-content${view === "working" ? " vc-content-working" : ""}`}
            >
              {view === "working" ? (
                <>
                  <div className="vc-section-title">
                    <h3>Uncommitted changes</h3>
                    <span>
                      {working
                        ? `${working.length} changed elements`
                        : "Comparing…"}
                    </span>
                  </div>
                  <p className="vc-description">
                    Changes since{" "}
                    <code>{project.initial.baseCommit.slice(0, 7)}</code>.
                    Commit the whole screenplay as one revision.
                  </p>
                  {stale && (
                    <div className="vc-warning vc-warning-action">
                      <span>
                        {project.branch} has new revisions since you started
                        this draft. Your writing is preserved. Bring the updates
                        in before committing.
                      </span>
                      <button
                        className="primary-action"
                        disabled={!ready || busy}
                        onClick={() => setView("update")}
                      >
                        Bring in updates
                      </button>
                    </div>
                  )}
                  {current?.protected && project.role !== "owner" && (
                    <p className="vc-warning">
                      Only the owner can commit to this protected branch. Create
                      a branch, commit there, then open a merge request.
                    </p>
                  )}
                  <ChangeList before={base} after={draft} />
                  <form
                    className="vc-commit-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void publish();
                    }}
                  >
                    <label htmlFor="commit-message">Commit message</label>
                    <textarea
                      id="commit-message"
                      placeholder="What changed in this revision?"
                      maxLength={2000}
                      value={message}
                      disabled={busy || readOnly}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                    <div>
                      <span>All changes · screenplay.json</span>
                      <button
                        className="primary-action"
                        disabled={!canCommit || !message.trim()}
                      >
                        {busy
                          ? (options?.commitLabels?.busy ?? "Publishing…")
                          : "Commit revision"}
                      </button>
                    </div>
                  </form>
                </>
              ) : view === "update" && current && getVersion && canPublish ? (
                <UpdateWorkspace
                  project={project}
                  draft={draft}
                  base={base}
                  head={current.head}
                  getVersion={getVersion}
                  canPublish={canPublish}
                />
              ) : view === "merge" || (view === "request" && activeRequest) ? (
                <MergeWorkspace
                  key={
                    view === "request"
                      ? `mr:${requestId}`
                      : `compose:${route.source}:${route.target}`
                  }
                  project={project}
                  branches={sortedBranches}
                  requests={requests}
                  request={view === "request" ? activeRequest : undefined}
                  initial={route}
                  readOnly={readOnly}
                  uncommittedOnSource={
                    route.source === project.branch && !!working?.length
                  }
                  onMerged={merged}
                  onRequestOpened={openRequest}
                />
              ) : (
                <>
                  <div className="vc-section-title">
                    <h3>
                      {scope ? (
                        <>
                          History <span className="vc-ref">{scope}</span>
                        </>
                      ) : (
                        "All branches"
                      )}
                    </h3>
                    {scope && (
                      <span className="vc-actions">
                        {scope !== project.branch && (
                          <button
                            className="vc-link"
                            disabled={!ready || busy}
                            onClick={() => navigate(scope)}
                          >
                            Switch to {scope}
                          </button>
                        )}
                        {writer && branches.length > 1 && (
                          <button
                            className="vc-link"
                            disabled={busy}
                            onClick={() => startMerge(scope)}
                          >
                            ⇄ Merge {scope}…
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {commits === null ? (
                    <TypewriterLoader contained />
                  ) : (
                    <CommitGraph
                      commits={visible}
                      branches={branches}
                      checkedOut={project.branch}
                      selected={selected?.oid ?? null}
                      onSelect={setSelected}
                      working={
                        readOnly || (scope !== null && scope !== project.branch)
                          ? null
                          : (working?.length ?? 0)
                      }
                      onWorking={() => setView("working")}
                      author={author}
                      tag={options?.revisionTag}
                    />
                  )}
                  {commits?.length === 300 && (
                    <p className="vc-description">
                      Showing the 300 newest revisions.
                    </p>
                  )}
                  {selected ? (
                    <div className="vc-detail">
                      <div className="vc-section-title">
                        <h3>{selected.message}</h3>
                        <code>{selected.oid.slice(0, 10)}</code>
                      </div>
                      <p className="vc-detail-meta">
                        <span
                          className={`vc-avatar lane-bg-${author(selected).color}`}
                        >
                          {author(selected).initials}
                        </span>
                        {author(selected).name} ·{" "}
                        {new Date(selected.timestamp * 1000).toLocaleString()}
                        {selected.parent.length > 0 && " · parents "}
                        {selected.parent.map((p) => (
                          <button
                            key={p}
                            className="vc-link"
                            disabled={!byId.has(p)}
                            onClick={() => {
                              const parent = byId.get(p);
                              if (parent) setSelected(parent);
                            }}
                          >
                            <code>{p.slice(0, 7)}</code>
                          </button>
                        ))}
                      </p>
                      {selected.merge && (
                        <p className="vc-description">
                          Merged {selected.merge.sourceBranch} into{" "}
                          {selected.merge.targetBranch}. Changes below are what
                          the merge brought into {selected.merge.targetBranch}.
                        </p>
                      )}
                      <ChangeList
                        before={comparison?.before}
                        after={comparison?.after}
                      />
                    </div>
                  ) : (
                    <div className="vc-placeholder">
                      Select a revision to inspect its screenplay changes.
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </dialog>
  );
}
