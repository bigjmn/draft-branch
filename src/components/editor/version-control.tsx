"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBranch,
  commitDraft,
  loadBranchHistory,
  readProjectRevision,
  watchBranches,
  watchCommit,
  type Branch,
  type RevisionSummary,
} from "@/lib/projects/client";
import { draftChanges } from "@/lib/projects/changes";
import { ELEMENT_LABELS, type Draft } from "@/lib/editor/types";
import type { EditorProject } from "./use-project-draft";
interface Props {
  project?: EditorProject;
  draft: Draft;
  saved: boolean;
  getVersion?: () => number;
  canPublish?: () => boolean;
}
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
  project,
  draft,
  saved,
  getVersion,
  canPublish,
  close,
}: Props & { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [view, setView] = useState("working");
  const [browse, setBrowse] = useState(project?.branch || "main");
  const [history, setHistory] = useState<RevisionSummary[] | null>(null);
  const [selected, setSelected] = useState<RevisionSummary | null>(null);
  const [comparison, setComparison] = useState<{
    before: Draft;
    after: Draft;
  } | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
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
  useEffect(() => {
    if (!project) return;
    let active = true;
    const unsub = watchBranches(project.id, setBranches, () =>
      setError("Couldn’t load branches. Check your connection."),
    );
    readProjectRevision(project.id, project.initial.baseCommit)
      .then((r) => {
        if (active) setBase(r.draft);
      })
      .catch(() => {
        if (active) setError("Couldn’t load the base revision.");
      });
    return () => {
      active = false;
      unsub();
    };
  }, [project?.id, project?.initial.baseCommit]);
  const current = branches.find((b) => b.name === project?.branch);
  const browsed = branches.find((b) => b.name === browse);
  const stale = !!current && current.head !== project?.initial.baseCommit;
  useEffect(() => {
    if (!project || !browsed) return;
    let active = true;
    setHistory(null);
    loadBranchHistory(project.id, browsed.head)
      .then((rows) => {
        if (active) setHistory(rows);
      })
      .catch(() => {
        if (active) setError("Couldn’t load history.");
      });
    return () => {
      active = false;
    };
  }, [project?.id, browsed?.head]);
  useEffect(() => {
    if (!project || !selected) return;
    let active = true;
    setComparison(null);
    Promise.all([
      readProjectRevision(project.id, selected.oid),
      selected.parent[0]
        ? readProjectRevision(project.id, selected.parent[0])
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
  const changes = useMemo(
    () =>
      view === "working"
        ? base
          ? draftChanges(base, draft)
          : null
        : comparison
          ? draftChanges(comparison.before, comparison.after)
          : null,
    [view, base, draft, comparison],
  );
  const ready = saved && !!canPublish?.();
  const canCommit =
    !!project &&
    ready &&
    !!base &&
    !!changes?.length &&
    !stale &&
    !!current &&
    (!current.protected || project.role === "owner") &&
    !busy;
  function navigate(name: string) {
    if (!ready || busy || !canPublish?.()) return;
    window.location.assign(
      `/editor?project=${encodeURIComponent(project!.id)}&branch=${encodeURIComponent(name)}`,
    );
  }
  async function publish() {
    if (!canCommit || !message.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("Publishing revision…");
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
            setNotice("Revision published. Reopening your draft…");
            window.location.reload();
          } else {
            setBusy(false);
            lock.current = false;
            setNotice("");
            setError(
              result.error ||
                "The branch changed. Your draft is preserved; reconcile it before committing.",
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
    if (!project || !browsed || !ready || lock.current || !canPublish?.())
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await createBranch(project.id, branchName, browse, browsed.head);
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
        <span className="vc-private">Private repository</span>
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
              disabled={!ready || busy}
              onClick={() => setCreating(!creating)}
            >
              ⑂ New branch
            </button>
            <span className="vc-sync">
              {saved ? "Cloud draft saved" : "Waiting for cloud save…"}
            </span>
          </div>
          {creating && (
            <form
              className="vc-branch-form"
              onSubmit={(e) => {
                e.preventDefault();
                void branch();
              }}
            >
              <label>
                Branch from {browse}
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
                disabled={!ready || busy || !branchName || !browsed}
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
              <button
                aria-pressed={view === "working"}
                onClick={() => {
                  setView("working");
                  setSelected(null);
                }}
              >
                ◉ Working draft
              </button>
              <button
                aria-pressed={view === "history"}
                onClick={() => setView("history")}
              >
                ◷ History
              </button>
              <div className="eyebrow vc-branch-heading">
                BRANCHES <span>{branches.length}</span>
              </div>
              {branches.map((b) => (
                <button
                  className="vc-branch"
                  key={b.name}
                  aria-pressed={browse === b.name && view === "history"}
                  onClick={() => {
                    setBrowse(b.name);
                    setView("history");
                    setSelected(null);
                    setComparison(null);
                  }}
                >
                  <span>⑂ {b.name}</span>
                  <small>
                    {b.name === project.branch
                      ? "HEAD"
                      : b.protected
                        ? "protected"
                        : ""}
                  </small>
                </button>
              ))}
              <p className="vc-sidebar-note">
                Commits publish directly to this private project. Merging
                branches is not available yet.
              </p>
            </nav>
            <section className="vc-content">
              {view === "working" ? (
                <>
                  <div className="vc-section-title">
                    <h3>Working draft</h3>
                    <span>
                      {changes
                        ? `${changes.length} changed elements`
                        : "Comparing…"}
                    </span>
                  </div>
                  <p className="vc-description">
                    Changes since{" "}
                    <code>{project.initial.baseCommit.slice(0, 7)}</code>.
                    Commit the whole screenplay as one revision.
                  </p>
                  {stale && (
                    <p className="vc-warning">
                      This branch has advanced. Your writing is preserved;
                      export and reconcile it before committing.
                    </p>
                  )}
                  {current?.protected && project.role !== "owner" && (
                    <p className="vc-warning">
                      Only the owner can commit to this protected branch. Create
                      a branch to publish your own revisions.
                    </p>
                  )}
                  <ChangeList changes={changes} />
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
                      disabled={busy}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                    <div>
                      <span>All changes · screenplay.json</span>
                      <button
                        className="primary-action"
                        disabled={!canCommit || !message.trim()}
                      >
                        {busy ? "Publishing…" : "Commit revision"}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <>
                  <div className="vc-section-title">
                    <h3>
                      History <span className="vc-ref-label">{browse}</span>
                    </h3>
                    {browse !== project.branch && (
                      <button
                        className="vc-switch"
                        disabled={!ready || busy}
                        onClick={() => navigate(browse)}
                      >
                        Switch to branch →
                      </button>
                    )}
                  </div>
                  <div className="vc-history" aria-label="Commit history">
                    {history === null ? (
                      <p role="status">Loading history…</p>
                    ) : (
                      history.map((r, i) => (
                        <button
                          className={`vc-revision${selected?.oid === r.oid ? " selected" : ""}`}
                          key={r.oid}
                          onClick={() => {
                            setSelected(r);
                            setComparison(null);
                          }}
                        >
                          <span
                            className={`vc-graph${i === history.length - 1 ? " last" : ""}`}
                            aria-hidden="true"
                          >
                            ●
                          </span>
                          <span className="vc-revision-message">
                            {r.message}
                            {branches
                              .filter((b) => b.head === r.oid)
                              .map((b) => (
                                <span key={b.name} className="vc-ref-label">
                                  {b.name}
                                </span>
                              ))}
                            <small>
                              {r.actorUid === project.uid
                                ? "You"
                                : `Writer ${r.actorUid.slice(0, 7)}`}{" "}
                              · {new Date(r.timestamp * 1000).toLocaleString()}
                            </small>
                          </span>
                          <code>{r.oid.slice(0, 7)}</code>
                        </button>
                      ))
                    )}
                  </div>
                  {history?.length === 50 && (
                    <p className="vc-description">
                      Showing the latest 50 revisions along this branch’s
                      first-parent history.
                    </p>
                  )}
                  {selected ? (
                    <>
                      <div className="vc-section-title">
                        <h3>Revision changes</h3>
                        <code>{selected.oid.slice(0, 7)}</code>
                      </div>
                      <ChangeList changes={changes} />
                    </>
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
function ChangeList({
  changes,
}: {
  changes: ReturnType<typeof draftChanges> | null;
}) {
  if (!changes)
    return (
      <p className="vc-placeholder" role="status">
        Loading changes…
      </p>
    );
  if (!changes.length)
    return (
      <div className="vc-placeholder">✓ No changes since this revision.</div>
    );
  return (
    <div className="vc-changes">
      {changes.map((c) => (
        <details
          key={`${c.isTitle ? "title" : "block"}:${c.id}`}
          className={`vc-change ${c.kind}`}
        >
          <summary>
            <span className="vc-change-kind">{c.kind}</span>
            <strong>
              {c.isTitle
                ? "Title"
                : ELEMENT_LABELS[(c.after || c.before)!.type]}
            </strong>
            <span className="vc-change-preview">
              {(c.after || c.before)!.text || "Empty element"}
            </span>
          </summary>
          {c.before && (
            <pre className="vc-before">
              <span>Before · {ELEMENT_LABELS[c.before.type]}</span>
              {c.before.text || "(empty)"}
            </pre>
          )}
          {c.after && (
            <pre className="vc-after">
              <span>After · {ELEMENT_LABELS[c.after.type]}</span>
              {c.after.text || "(empty)"}
            </pre>
          )}
          {c.kind === "moved" && <p>Element order changed.</p>}
        </details>
      ))}
    </div>
  );
}
