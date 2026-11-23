"use client";
import { useEffect, useRef, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { firebaseDb } from "@/lib/firebase/client";
import { useAuth } from "@/components/auth/auth-provider";
import type { ScriptBlock } from "@/lib/editor/types";
interface Comment {
  id: string;
  authorName: string;
  blockId: string;
  quote: string;
  text: string;
  resolved: boolean;
  createdAt?: { toMillis: () => number };
}
export function ProjectComments({
  projectId,
  branch,
  owner,
  selected,
  blocks,
  onFocus,
  onClose,
}: {
  projectId: string;
  branch: string;
  owner: boolean;
  selected: ScriptBlock | undefined;
  blocks: ScriptBlock[];
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showResolved, setShowResolved] = useState(false),
    [loading, setLoading] = useState(true);
  const pending = useRef<{ key: string; id: string } | null>(null);
  useEffect(
    () =>
      onSnapshot(
        query(
          collection(firebaseDb(), "projects", projectId, "comments"),
          where("branch", "==", branch),
        ),
        (snapshot) => {
          setComments(
            snapshot.docs
              .map((d) => ({ ...d.data(), id: d.id }) as Comment)
              .sort(
                (a, b) =>
                  (a.createdAt?.toMillis() ?? Date.now()) -
                  (b.createdAt?.toMillis() ?? Date.now()),
              ),
          );
          setLoading(false);
        },
        () => {
          setError(
            "Comments could not be loaded. Check your access and connection.",
          );
          setLoading(false);
        },
      ),
    [projectId, branch],
  );
  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError("The change could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="project-comments" aria-label="Screenplay comments">
      <div className="comments-heading">
        <div>
          <h2>Comments</h2>
          <p>Branch: {branch}</p>
        </div>
        <button aria-label="Close comments" onClick={onClose}>
          ×
        </button>
      </div>
      <label className="comments-filter">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => setShowResolved(e.target.checked)}
        />{" "}
        Show resolved
      </label>
      <div className="comments-list">
        {loading ? (
          <p>Loading comments…</p>
        ) : comments.filter((c) => showResolved || !c.resolved).length === 0 ? (
          <p className="comments-empty">
            No {showResolved ? "" : "open "}comments on this branch.
          </p>
        ) : (
          comments
            .filter((c) => showResolved || !c.resolved)
            .map((c) => (
              <article
                key={c.id}
                className={c.resolved ? "comment is-resolved" : "comment"}
              >
                <strong>{c.authorName}</strong>
                <button
                  className="comment-quote"
                  disabled={!blocks.some((b) => b.id === c.blockId)}
                  onClick={() => onFocus(c.blockId)}
                >
                  {c.quote || "Empty screenplay element"}
                </button>
                {!blocks.some((b) => b.id === c.blockId) && (
                  <small>This element is no longer in this draft.</small>
                )}
                <p>{c.text}</p>
                {owner && (
                  <div className="comment-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          updateDoc(
                            doc(
                              firebaseDb(),
                              "projects",
                              projectId,
                              "comments",
                              c.id,
                            ),
                            { resolved: !c.resolved },
                          ),
                        )
                      }
                    >
                      {c.resolved ? "Reopen" : "Resolve"}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("Delete this comment?"))
                          void mutate(() =>
                            deleteDoc(
                              doc(
                                firebaseDb(),
                                "projects",
                                projectId,
                                "comments",
                                c.id,
                              ),
                            ),
                          );
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </article>
            ))
        )}
      </div>
      {owner && (
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selected || !user || !text.trim() || busy) return;
            const key = JSON.stringify([branch, selected.id, text.trim()]);
            if (pending.current?.key !== key)
              pending.current = { key, id: crypto.randomUUID() };
            void mutate(async () => {
              const existingRef = doc(
                firebaseDb(),
                "projects",
                projectId,
                "comments",
                pending.current!.id,
              );
              if (!(await getDoc(existingRef)).exists())
                await setDoc(
                  doc(
                    firebaseDb(),
                    "projects",
                    projectId,
                    "comments",
                    pending.current!.id,
                  ),
                  {
                    authorUid: user.uid,
                    authorName: (user.displayName || "Project owner").slice(
                      0,
                      100,
                    ),
                    branch,
                    blockId: selected.id,
                    quote: selected.text.slice(0, 500),
                    text: text.trim(),
                    resolved: false,
                    createdAt: serverTimestamp(),
                  },
                );
              setText("");
              pending.current = null;
            });
          }}
        >
          <label htmlFor="new-comment">
            {selected
              ? "Comment on selected element"
              : "Select a screenplay element to comment"}
          </label>
          {selected && (
            <blockquote>
              {selected.text.slice(0, 160) || "Empty element"}
            </blockquote>
          )}
          <textarea
            id="new-comment"
            rows={3}
            maxLength={2000}
            disabled={busy || !selected}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Leave a note on these pages…"
          />
          <button
            className="primary-action"
            disabled={busy || !selected || !text.trim()}
          >
            {busy ? "Saving…" : "Add comment"}
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
