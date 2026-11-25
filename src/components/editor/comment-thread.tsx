"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  addComment,
  deleteComment,
  editComment,
  resolveComment,
  type ScriptComment,
} from "@/lib/projects/comments";

export interface CommentPermissions {
  uid: string;
  authorName: string;
  /** May post on this branch. */
  canComment: boolean;
  /** The owner: resolves and deletes anyone's notes. */
  canModerate: boolean;
}

/** The comments on one screenplay element: read them, add one, and edit,
 * resolve or delete your own. */
export function CommentThread({
  projectId,
  branch,
  blockId,
  quote,
  comments,
  permissions,
  onClose,
  style,
  className = "",
}: {
  projectId: string;
  branch: string;
  blockId: string;
  quote: string;
  comments: ScriptComment[];
  permissions: CommentPermissions;
  onClose: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One id per note being written, so retrying a failed post can't duplicate it.
  const pending = useRef<{ text: string; id: string } | null>(null);
  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  useEffect(() => {
    if (!open.length && permissions.canComment) input.current?.focus();
    // Only when the thread opens.
  }, [blockId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        root.current &&
        target &&
        !root.current.contains(target) &&
        !target.closest?.("[data-comment-toggle]")
      )
        onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [busy, onClose]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch {
      setError("That didn’t save. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function post() {
    const value = text.trim();
    if (!value || !permissions.canComment) return;
    if (pending.current?.text !== value)
      pending.current = { text: value, id: crypto.randomUUID() };
    const id = pending.current.id;
    if (
      await run(() =>
        addComment({
          projectId,
          id,
          authorUid: permissions.uid,
          authorName: permissions.authorName,
          branch,
          blockId,
          quote,
          text: value,
        }),
      )
    ) {
      pending.current = null;
      setText("");
    }
  }
  async function saveEdit() {
    if (!editing || !editing.text.trim()) return;
    if (await run(() => editComment(projectId, editing.id, editing.text)))
      setEditing(null);
  }
  const submitKeys = (action: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      action();
    }
  };

  const item = (c: ScriptComment) => {
    const mine = c.authorUid === permissions.uid;
    return (
      <li key={c.id} className={c.resolved ? "is-resolved" : undefined}>
        <div className="comment-meta">
          <strong>{mine ? "You" : c.authorName}</strong>
          <span>
            {when(c)}
            {c.updatedAt ? " · edited" : ""}
            {c.resolved ? " · resolved" : ""}
          </span>
        </div>
        {editing?.id === c.id ? (
          <div className="comment-edit">
            <textarea
              aria-label="Edit comment"
              rows={3}
              maxLength={2000}
              value={editing.text}
              disabled={busy}
              autoFocus
              onKeyDown={submitKeys(() => void saveEdit())}
              onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
            />
            <div className="comment-buttons">
              <button
                type="button"
                className="comment-primary"
                disabled={busy || !editing.text.trim()}
                onClick={() => void saveEdit()}
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p>{c.text}</p>
        )}
        {editing?.id !== c.id && (mine || permissions.canModerate) && (
          <div className="comment-buttons">
            {mine && permissions.canComment && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing({ id: c.id, text: c.text })}
              >
                Edit
              </button>
            )}
            {(mine ? permissions.canComment : permissions.canModerate) && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => resolveComment(projectId, c.id, !c.resolved))
                }
              >
                {c.resolved ? "Reopen" : "Resolve"}
              </button>
            )}
            <button
              type="button"
              className="comment-danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Delete this comment?"))
                  void run(() => deleteComment(projectId, c.id));
              }}
            >
              Delete
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div
      ref={root}
      className={`comment-thread ${className}`}
      style={style}
      role="dialog"
      aria-label="Comments on this line"
    >
      <div className="comment-thread-head">
        <span className="comment-thread-quote">
          {quote.trim() || "Empty line"}
        </span>
        <button type="button" aria-label="Close comments" onClick={onClose}>
          ×
        </button>
      </div>
      {open.length > 0 && <ol className="comment-items">{open.map(item)}</ol>}
      {resolved.length > 0 && (
        <>
          <button
            type="button"
            className="comment-show-resolved"
            aria-expanded={showResolved}
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          {showResolved && (
            <ol className="comment-items">{resolved.map(item)}</ol>
          )}
        </>
      )}
      {permissions.canComment ? (
        <div className="comment-new">
          <textarea
            ref={input}
            aria-label="Add a comment"
            rows={open.length ? 2 : 3}
            maxLength={2000}
            value={text}
            disabled={busy}
            placeholder={open.length ? "Reply…" : "Add a comment…"}
            onKeyDown={submitKeys(() => void post())}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="comment-buttons">
            <small>⌘↵ to post</small>
            <button
              type="button"
              className="comment-primary"
              disabled={busy || !text.trim()}
              onClick={() => void post()}
            >
              {busy ? "Saving…" : open.length ? "Reply" : "Comment"}
            </button>
          </div>
        </div>
      ) : (
        !comments.length && (
          <p className="comment-empty">No comments on this line.</p>
        )
      )}
      {error && (
        <p className="comment-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function when(c: ScriptComment) {
  const millis = c.createdAt?.toMillis();
  if (!millis) return "just now";
  const minutes = Math.round((Date.now() - millis) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(millis).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The chat icon used in the margin. */
export function CommentIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
