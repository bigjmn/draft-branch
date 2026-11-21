"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  closeMergeRequest,
  mergeBranches,
  openMergeRequest,
  previewMerge,
  readProjectRevision,
  saveProjectDraft,
  type Branch,
  type MergePreview,
  type MergeRequest,
} from "@/lib/projects/client";
import {
  mergeDrafts,
  type MergeBlock,
  type MergeConflict,
  type Resolution,
} from "@/lib/projects/merge";
import { draftChanges } from "@/lib/projects/changes";
import type { Draft } from "@/lib/editor/types";
import { ChangeList, elementLabel, sceneIndex } from "./vc-changes";
import type { EditorProject } from "./use-project-draft";

interface Labels {
  target: string;
  source: string;
}
type Resolutions = Record<string, Resolution>;
const errorText = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

/** Keep one request id per identical input so retries replay, not duplicate. */
function useRequestId() {
  const ref = useRef<{ signature: string; id: string } | null>(null);
  return (signature: string) => {
    if (ref.current?.signature !== signature)
      ref.current = { signature, id: crypto.randomUUID() };
    return ref.current.id;
  };
}

/** Merge one branch into another, or review an open merge request. */
export function MergeWorkspace({
  project,
  branches,
  requests,
  request,
  initial,
  readOnly,
  uncommittedOnSource,
  onMerged,
  onRequestOpened,
}: {
  project: EditorProject;
  branches: Branch[];
  requests: MergeRequest[];
  request?: MergeRequest;
  initial: { source: string; target: string };
  readOnly: boolean;
  uncommittedOnSource: boolean;
  onMerged: (target: string) => void;
  onRequestOpened: (id: string) => void;
}) {
  const [source, setSource] = useState(request?.sourceBranch ?? initial.source);
  const [target, setTarget] = useState(request?.targetBranch ?? initial.target);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const requestId = useRequestId();
  const sourceBranch = branches.find((b) => b.name === source);
  const targetBranch = branches.find((b) => b.name === target);
  const heads = `${sourceBranch?.head}:${targetBranch?.head}`;
  const both = !!sourceBranch && !!targetBranch;
  useEffect(() => {
    if (request) {
      setSource(request.sourceBranch);
      setTarget(request.targetBranch);
    }
  }, [request]);
  useEffect(() => {
    if (!both || source === target) {
      setPreview(null);
      return;
    }
    let active = true;
    setError("");
    previewMerge(project.id, source, target)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((e) => {
        if (active) {
          setPreview(null);
          setError(errorText(e, "Couldn’t prepare the merge preview."));
        }
      });
    return () => {
      active = false;
    };
    // `heads` re-runs the preview whenever either branch moves.
  }, [project.id, source, target, heads, both]);
  const current =
    !!preview &&
    preview.sourceHead === sourceBranch?.head &&
    preview.targetHead === targetBranch?.head;
  const result = useMemo(
    () =>
      preview
        ? mergeDrafts(preview.base, preview.target, preview.source, resolutions)
        : null,
    [preview, resolutions],
  );
  const changes = useMemo(
    () =>
      preview && result
        ? draftChanges(preview.target, result.draft as Draft)
        : null,
    [preview, result],
  );
  const role = project.role;
  const writer = !readOnly && (role === "owner" || role === "editor");
  const canMerge =
    writer && !!targetBranch && (!targetBranch.protected || role === "owner");
  const openRequest =
    request?.status === "open"
      ? request
      : requests.find(
          (r) =>
            r.status === "open" &&
            r.sourceBranch === source &&
            r.targetBranch === target,
        );
  const reverseAllowed =
    writer &&
    !!sourceBranch &&
    (!sourceBranch.protected || role === "owner") &&
    !canMerge;
  const labels = { target, source };
  const unresolved = result?.unresolved.length ?? 0;
  const commitMessage = message.trim() || `Merge ${source} into ${target}`;

  async function merge() {
    if (!preview || !result || !canMerge || unresolved || busy || !current)
      return;
    setBusy(true);
    setError("");
    const input = {
      projectId: project.id,
      sourceBranch: source,
      targetBranch: target,
      expectedSourceHead: preview.sourceHead,
      expectedTargetHead: preview.targetHead,
      resolutions: Object.fromEntries(
        result.conflicts.map((c) => [c.id, resolutions[c.id]]),
      ),
      message: commitMessage,
      ...(openRequest ? { mergeRequestId: openRequest.id } : {}),
    };
    try {
      await mergeBranches({
        ...input,
        requestId: requestId(JSON.stringify(input)),
      });
      onMerged(target);
    } catch (e) {
      setError(errorText(e, "Merge failed. Nothing was changed."));
      setBusy(false);
    }
  }
  async function propose() {
    if (!writer || busy || !title.trim()) return;
    setBusy(true);
    setError("");
    const input = {
      projectId: project.id,
      sourceBranch: source,
      targetBranch: target,
      title: title.trim(),
      description: description.trim(),
    };
    try {
      const created = await openMergeRequest({
        ...input,
        requestId: requestId(JSON.stringify(input)),
      });
      onRequestOpened(created.mergeRequestId);
    } catch (e) {
      setError(errorText(e, "Couldn’t open the merge request."));
    }
    setBusy(false);
  }
  async function close() {
    if (!request || busy) return;
    setBusy(true);
    try {
      await closeMergeRequest(project.id, request.id);
    } catch (e) {
      setError(errorText(e, "Couldn’t close the request."));
    }
    setBusy(false);
  }

  const status = request ? request.status : null;
  return (
    <div className="vc-merge">
      <div className="vc-section-title">
        <h3>
          {request ? (
            <>
              <span className={`vc-mr-status ${request.status}`}>
                {request.status}
              </span>
              {request.title}
            </>
          ) : (
            "Merge branches"
          )}
        </h3>
        {preview && (
          <span>
            merge base <code>{preview.baseCommit.slice(0, 7)}</code>
          </span>
        )}
      </div>
      {request && (
        <p className="vc-description">
          Requested by {request.authorName || "a writer"} ·{" "}
          {new Date(request.createdAt).toLocaleString()}
          {request.status === "merged" &&
            ` · merged by ${request.mergedByName || "the owner"}`}
          {request.status === "closed" &&
            ` · closed by ${request.closedByName || "a writer"}`}
          {request.description && (
            <span className="vc-mr-description">{request.description}</span>
          )}
        </p>
      )}
      <div className="vc-merge-route">
        <BranchPick
          label="From"
          value={source}
          branches={branches}
          fixed={!!request}
          onChange={(name) => {
            setSource(name);
            setResolutions({});
          }}
        />
        <span aria-hidden="true">→</span>
        <BranchPick
          label="Into"
          value={target}
          branches={branches}
          fixed={!!request}
          onChange={(name) => {
            setTarget(name);
            setResolutions({});
          }}
        />
        {reverseAllowed && !request && (
          <button
            className="vc-link"
            onClick={() => {
              setSource(target);
              setTarget(source);
              setResolutions({});
            }}
          >
            ⇄ Bring {target} into {source} instead
          </button>
        )}
      </div>
      {source === target && (
        <div className="vc-placeholder">Choose two different branches.</div>
      )}
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      {uncommittedOnSource && !request && (
        <p className="vc-warning">
          Only committed revisions are merged. Commit your working draft on{" "}
          {source} first to include it.
        </p>
      )}
      {source !== target &&
        (!preview || !result ? (
          !error && <TypewriterLoader contained />
        ) : status === "merged" || status === "closed" ? (
          <div className="vc-placeholder">
            {status === "merged"
              ? `Merged into ${target}${request?.mergedCommit ? ` as ${request.mergedCommit.slice(0, 7)}` : ""}.`
              : "This request was closed without merging."}
          </div>
        ) : preview.upToDate ? (
          <div className="vc-placeholder">
            ✓ Nothing to merge. {target} already contains every revision on{" "}
            {source}.
          </div>
        ) : (
          <>
            {!current && (
              <p className="vc-notice" role="status">
                A branch just changed. Refreshing the preview…
              </p>
            )}
            <div className="vc-merge-summary">
              <span className={unresolved ? "conflicted" : "clean"}>
                {result.conflicts.length === 0
                  ? "✓ No conflicts"
                  : unresolved
                    ? `${unresolved} of ${result.conflicts.length} conflicts need a decision`
                    : `✓ All ${result.conflicts.length} conflicts resolved`}
              </span>
              <span>
                {changes?.length ?? 0} element changes to {target}
              </span>
            </div>
            {result.conflicts.length > 0 && (
              <ConflictList
                conflicts={result.conflicts}
                resolutions={resolutions}
                onChange={setResolutions}
                labels={labels}
                disabled={!canMerge || busy}
                drafts={[preview.target, preview.source]}
                note={
                  canMerge
                    ? undefined
                    : request
                      ? "The project owner resolves these when approving the merge."
                      : `The owner resolves these when approving. To settle them yourself, bring ${target} into ${source} first.`
                }
              />
            )}
            <div className="vc-section-title vc-spaced">
              <h3>Result on {target}</h3>
            </div>
            <ChangeList before={preview.target} after={result.draft as Draft} />
            {canMerge ? (
              <form
                className="vc-commit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void merge();
                }}
              >
                <label htmlFor="merge-message">Merge message</label>
                <textarea
                  id="merge-message"
                  placeholder={`Merge ${source} into ${target}`}
                  maxLength={2000}
                  value={message}
                  disabled={busy}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div>
                  <span>
                    {targetBranch?.protected
                      ? `As owner, merging approves these changes for ${target}.`
                      : `Creates a merge revision on ${target}.`}
                  </span>
                  <span className="vc-actions">
                    {request && (
                      <button
                        type="button"
                        className="vc-link"
                        disabled={busy}
                        onClick={() => void close()}
                      >
                        Close request
                      </button>
                    )}
                    <button
                      className="primary-action"
                      disabled={busy || !!unresolved || !current}
                    >
                      {busy
                        ? "Merging…"
                        : request || targetBranch?.protected
                          ? `Approve & merge into ${target}`
                          : `Merge into ${target}`}
                    </button>
                  </span>
                </div>
              </form>
            ) : request ? (
              <div className="vc-commit-form">
                <div>
                  <span>
                    Waiting for the project owner to approve this merge.
                  </span>
                  {writer && request.authorUid === project.uid && (
                    <button
                      className="vc-link"
                      disabled={busy}
                      onClick={() => void close()}
                    >
                      Close request
                    </button>
                  )}
                </div>
              </div>
            ) : openRequest ? (
              <div className="vc-commit-form">
                <div>
                  <span>
                    A merge request for these branches is already open.
                  </span>
                  <button
                    className="primary-action"
                    onClick={() => onRequestOpened(openRequest.id)}
                  >
                    View request
                  </button>
                </div>
              </div>
            ) : writer ? (
              <form
                className="vc-commit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void propose();
                }}
              >
                <label htmlFor="mr-title">Request title</label>
                <input
                  id="mr-title"
                  className="vc-input"
                  placeholder={`Bring ${source} into ${target}`}
                  maxLength={200}
                  required
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <label htmlFor="mr-description">Notes for the owner</label>
                <textarea
                  id="mr-description"
                  placeholder="What changed and why?"
                  maxLength={4000}
                  value={description}
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <div>
                  <span>
                    {target} is protected. The owner reviews and merges.
                  </span>
                  <button
                    className="primary-action"
                    disabled={busy || !title.trim()}
                  >
                    {busy ? "Opening…" : "Open merge request"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="vc-description">
                Read-only access can review merges but not perform them.
              </p>
            )}
          </>
        ))}
    </div>
  );
}

function BranchPick({
  label,
  value,
  branches,
  fixed,
  onChange,
}: {
  label: string;
  value: string;
  branches: Branch[];
  fixed: boolean;
  onChange: (name: string) => void;
}) {
  return (
    <label className="vc-branch-pick">
      <small>{label}</small>
      {fixed ? (
        <span className="vc-ref">{value}</span>
      ) : (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.protected ? " (protected)" : ""}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

/** Rebase-like update: bring the branch's newest revision into an
 * uncommitted working draft, resolving conflicts before saving. */
export function UpdateWorkspace({
  project,
  draft,
  base,
  head,
  getVersion,
  canPublish,
}: {
  project: EditorProject;
  draft: Draft;
  base: Draft | null;
  head: string;
  getVersion: () => number;
  canPublish: () => boolean;
}) {
  const [latest, setLatest] = useState<Draft | null>(null);
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRequestId();
  useEffect(() => {
    let active = true;
    setLatest(null);
    readProjectRevision(project.id, head)
      .then((r) => active && setLatest(r.draft))
      .catch(() => active && setError("Couldn’t load the latest revision."));
    return () => {
      active = false;
    };
  }, [project.id, head]);
  const result = useMemo(
    () =>
      base && latest ? mergeDrafts(base, draft, latest, resolutions) : null,
    [base, latest, draft, resolutions],
  );
  const changes = useMemo(
    () => (result ? draftChanges(draft, result.draft as Draft) : null),
    [draft, result],
  );
  const labels = { target: "Your draft", source: `${project.branch} (latest)` };
  async function apply() {
    if (!result || result.unresolved.length || busy) return;
    if (!canPublish()) {
      setError(
        "Wait for your latest writing to finish saving, then try again.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const input = {
      projectId: project.id,
      branchId: project.branch,
      baseCommit: head,
      expectedVersion: getVersion(),
      draft: result.draft as Draft,
    };
    try {
      const saved = await saveProjectDraft({
        ...input,
        requestId: requestId(JSON.stringify(input)),
      });
      if (saved.status !== "accepted")
        throw new Error(saved.error || "The cloud draft changed.");
      window.location.reload();
    } catch (e) {
      setBusy(false);
      setError(
        errorText(
          e,
          "Couldn’t save the updated draft. Your writing is unchanged.",
        ),
      );
    }
  }
  return (
    <div className="vc-merge">
      <div className="vc-section-title">
        <h3>Bring in updates</h3>
        <span>
          <code>{project.initial.baseCommit.slice(0, 7)}</code> →{" "}
          <code>{head.slice(0, 7)}</code>
        </span>
      </div>
      <p className="vc-description">
        {project.branch} moved on since you started this draft. Combine the
        newest revision with your uncommitted writing, then commit as usual.
      </p>
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      {!result ? (
        !error && <TypewriterLoader contained />
      ) : (
        <>
          <div className="vc-merge-summary">
            <span className={result.unresolved.length ? "conflicted" : "clean"}>
              {result.conflicts.length === 0
                ? "✓ No conflicts"
                : result.unresolved.length
                  ? `${result.unresolved.length} of ${result.conflicts.length} conflicts need a decision`
                  : `✓ All ${result.conflicts.length} conflicts resolved`}
            </span>
            <span>{changes?.length ?? 0} incoming element changes</span>
          </div>
          {result.conflicts.length > 0 && (
            <ConflictList
              conflicts={result.conflicts}
              resolutions={resolutions}
              onChange={setResolutions}
              labels={labels}
              disabled={busy}
              drafts={[draft, latest!]}
            />
          )}
          <div className="vc-section-title vc-spaced">
            <h3>Incoming changes</h3>
          </div>
          <ChangeList before={draft} after={result.draft as Draft} />
          <div className="vc-commit-form">
            <div>
              <span>
                Your draft is saved with the combined text. Nothing is
                committed.
              </span>
              <button
                className="primary-action"
                disabled={busy || !!result.unresolved.length}
                onClick={() => void apply()}
              >
                {busy ? "Updating…" : "Update my draft"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const CONFLICT_TITLES: Record<MergeConflict["kind"], string> = {
  title: "Both changed the title",
  content: "Both edited this element",
  delete: "Deleted on one side, edited on the other",
  order: "Both added or rearranged material here",
  move: "Both moved this element to different places",
};

export function ConflictList({
  conflicts,
  resolutions,
  onChange,
  labels,
  disabled,
  drafts,
  note,
}: {
  conflicts: MergeConflict[];
  resolutions: Resolutions;
  onChange: (next: Resolutions) => void;
  labels: Labels;
  disabled: boolean;
  drafts: Draft[];
  note?: string;
}) {
  const scenes = useMemo(() => sceneIndex(...drafts), [drafts]);
  const set = (id: string, value: Resolution) =>
    onChange({ ...resolutions, [id]: value });
  const all = (side: "target" | "source") =>
    onChange({
      ...resolutions,
      ...Object.fromEntries(conflicts.map((c) => [c.id, side])),
    });
  return (
    <section className="vc-conflicts" aria-label="Merge conflicts">
      <div className="vc-conflicts-head">
        <h3>Conflicts</h3>
        {!disabled && (
          <span>
            Use all from{" "}
            <button className="vc-link" onClick={() => all("target")}>
              {labels.target}
            </button>{" "}
            ·{" "}
            <button className="vc-link" onClick={() => all("source")}>
              {labels.source}
            </button>
          </span>
        )}
      </div>
      {note && <p className="vc-description">{note}</p>}
      {conflicts.map((conflict) => (
        <ConflictCard
          key={conflict.id}
          conflict={conflict}
          value={resolutions[conflict.id]}
          onChange={(value) => set(conflict.id, value)}
          labels={labels}
          disabled={disabled}
          scene={locate(conflict, scenes)}
        />
      ))}
    </section>
  );
}
function locate(conflict: MergeConflict, scenes: Map<string, string>) {
  if (conflict.kind === "title") return null;
  const anchor = conflict.id.slice(conflict.id.indexOf(":") + 1);
  if (anchor === "start") return "Opening of the screenplay";
  return scenes.get(anchor) ?? null;
}

function ConflictCard({
  conflict,
  value,
  onChange,
  labels,
  disabled,
  scene,
}: {
  conflict: MergeConflict;
  value: Resolution | undefined;
  onChange: (value: Resolution) => void;
  labels: Labels;
  disabled: boolean;
  scene: string | null;
}) {
  const custom = typeof value === "object";
  const [draftText, setDraftText] = useState(
    custom ? value.text : (conflict.target?.text ?? ""),
  );
  const resolved = value !== undefined;
  const option = (
    side: "target" | "source",
    body: ReactNode,
    caption?: string,
  ) => (
    <div
      className="vc-option"
      aria-pressed={value === side}
      aria-disabled={disabled}
    >
      <button
        type="button"
        className="vc-option-head vc-option-select"
        aria-pressed={value === side}
        disabled={disabled}
        onClick={() => onChange(side)}
      >
        <span className="vc-ref">{labels[side]}</span> {caption}{" "}
        <span>{value === side ? "✓ Selected" : "Use this version"}</span>
      </button>
      {body}
    </div>
  );
  const asDraft = (blocks: MergeBlock[]): Draft => ({
    title: blocks.find((b) => b.type === "title")?.text ?? "",
    blocks: blocks.filter((b) => b.type !== "title") as Draft["blocks"],
  });
  const blockText = (block: MergeBlock | null | undefined) => (
    <ChangeList
      before={asDraft(conflict.base ? [conflict.base] : [])}
      after={asDraft(block ? [block] : [])}
      collapse={false}
    />
  );
  const blockList = (blocks: MergeBlock[] = []) => (
    <ChangeList
      before={asDraft(conflict.targetBlocks ?? [])}
      after={asDraft(blocks)}
    />
  );
  return (
    <article className={`vc-conflict${resolved ? " resolved" : ""}`}>
      <div className="vc-conflict-head">
        <strong>{CONFLICT_TITLES[conflict.kind]}</strong>
        {scene && <span className="vc-conflict-scene">{scene}</span>}
        <span className="vc-conflict-state">
          {resolved ? "✓ Resolved" : "Needs a decision"}
        </span>
      </div>
      {conflict.base && conflict.kind !== "move" && (
        <details className="vc-conflict-base">
          <summary>Original</summary>
          {blockText(conflict.base)}
        </details>
      )}
      <div className="vc-options">
        {conflict.kind === "order" ? (
          <>
            {option("target", blockList(conflict.targetBlocks), "first")}
            {option("source", blockList(conflict.sourceBlocks), "first")}
          </>
        ) : conflict.kind === "move" ? (
          <>
            {option("target", blockText(conflict.target), "’s position")}
            {option("source", blockText(conflict.source), "’s position")}
          </>
        ) : (
          <>
            {option(
              "target",
              blockText(conflict.target),
              conflict.target ? undefined : "removed it",
            )}
            {option(
              "source",
              blockText(conflict.source),
              conflict.source ? undefined : "removed it",
            )}
          </>
        )}
        {conflict.options.includes("both") && (
          <button
            type="button"
            className="vc-option vc-option-small"
            aria-pressed={value === "both"}
            disabled={disabled}
            onClick={() => onChange("both")}
          >
            <span className="vc-option-head">Keep both</span>
            <p>
              {labels.target}’s version, then {labels.source}’s as a new
              element.
            </p>
          </button>
        )}
        {conflict.options.includes("text") && (
          <div
            className="vc-option vc-option-custom"
            aria-pressed={custom}
            aria-disabled={disabled}
          >
            <span className="vc-option-head">Write your own</span>
            {conflict.kind === "title" ? (
              <input
                className="vc-input"
                aria-label="Custom title"
                maxLength={200}
                value={draftText}
                disabled={disabled}
                onChange={(e) => {
                  setDraftText(e.target.value);
                  onChange({ text: e.target.value });
                }}
              />
            ) : (
              <textarea
                aria-label="Custom element text"
                value={draftText}
                disabled={disabled}
                onChange={(e) => {
                  setDraftText(e.target.value);
                  onChange({ text: e.target.value });
                }}
              />
            )}
          </div>
        )}
      </div>
    </article>
  );
}
