"use client";
import { useState } from "react";
import type { ScriptComment } from "@/lib/projects/comments";
import type { ScriptBlock } from "@/lib/editor/types";

/** Every note on the branch in script order, for finding your way around.
 * Notes are written and answered in the page margin. */
export function ProjectComments({
  branch,
  comments,
  error,
  blocks,
  onOpen,
  onClose,
}: {
  branch: string;
  comments: ScriptComment[];
  error?: boolean;
  blocks: ScriptBlock[];
  onOpen: (blockId: string) => void;
  onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const order = new Map(blocks.map((b, i) => [b.id, i]));
  const visible = comments
    .filter((c) => showResolved || !c.resolved)
    .sort(
      (a, b) =>
        (order.get(a.blockId) ?? Infinity) - (order.get(b.blockId) ?? Infinity),
    );
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
      <p className="comments-tip">
        Hover a line and click the chat icon in the left margin to add a
        comment.
      </p>
      <label className="comments-filter">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => setShowResolved(e.target.checked)}
        />{" "}
        Show resolved
      </label>
      <div className="comments-list">
        {error ? (
          <p className="comments-empty" role="alert">
            Comments could not be loaded. Check your access and connection.
          </p>
        ) : visible.length === 0 ? (
          <p className="comments-empty">
            No {showResolved ? "" : "open "}comments on this branch.
          </p>
        ) : (
          visible.map((c) => {
            const present = order.has(c.blockId);
            return (
              <article
                key={c.id}
                className={c.resolved ? "comment is-resolved" : "comment"}
              >
                <strong>{c.authorName}</strong>
                <button
                  className="comment-quote"
                  disabled={!present}
                  onClick={() => onOpen(c.blockId)}
                >
                  {c.quote || "Empty screenplay element"}
                </button>
                {!present && (
                  <small>This line is no longer in this draft.</small>
                )}
                <p>{c.text}</p>
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}
