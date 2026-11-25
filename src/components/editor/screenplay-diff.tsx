"use client";
import { createContext, useContext, useMemo, useState } from "react";
import { byBlock, type ScriptComment } from "@/lib/projects/comments";
import {
  CommentIcon,
  CommentThread,
  type CommentPermissions,
} from "./comment-thread";
import type { Draft } from "@/lib/editor/types";
import {
  screenplayDiff,
  foldDiff,
  type DiffRow,
} from "@/lib/projects/screenplay-diff";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

const SIGN: Record<DiffRow["kind"], { sign: string; label: string }> = {
  context: { sign: " ", label: "Unchanged" },
  added: { sign: "+", label: "Added" },
  removed: { sign: "−", label: "Removed" },
  changed: { sign: "±", label: "Edited" },
};
/** Notes on a branch's lines, shown in a diff's gutter (merge review). */
export interface DiffNotes {
  projectId: string;
  branch: string;
  comments: ScriptComment[];
  permissions: CommentPermissions;
}
const NotesContext = createContext<{
  notes: DiffNotes;
  threads: Map<string, ScriptComment[]>;
  open: string | null;
  setOpen: (id: string | null) => void;
} | null>(null);

/** The note icon at the start of a row, and the thread below it when open. */
function RowNotes({ row }: { row: DiffRow }) {
  const context = useContext(NotesContext);
  // Removed lines are gone from the branch, so there's nothing to anchor to.
  if (!context || row.title || row.kind === "removed") return null;
  const { notes, threads, open, setOpen } = context;
  const list = threads.get(row.block.id) ?? [];
  const count = list.filter((c) => !c.resolved).length;
  if (!count && !notes.permissions.canComment && !list.length) return null;
  const isOpen = open === row.block.id;
  return (
    <>
      <button
        type="button"
        data-comment-toggle
        className={`comment-pin script-diff-pin${count ? " is-set" : ""}${isOpen ? " is-open" : ""}`}
        aria-label={
          count
            ? `${count} ${count === 1 ? "comment" : "comments"} on this line`
            : "Add a comment to this line"
        }
        aria-expanded={isOpen}
        onClick={() => setOpen(isOpen ? null : row.block.id)}
      >
        <CommentIcon />
        {count > 1 && <span className="comment-count">{count}</span>}
      </button>
      {isOpen && (
        <CommentThread
          className="script-diff-thread"
          projectId={notes.projectId}
          branch={notes.branch}
          blockId={row.block.id}
          quote={row.block.text}
          comments={list}
          permissions={notes.permissions}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function Row({ row }: { row: DiffRow }) {
  const context = useContext(NotesContext);
  const open = context?.open === row.block.id && !row.title;
  return (
    <div
      className={`script-diff-row script-diff-${row.kind}${open ? " has-thread" : ""}`}
    >
      <RowNotes row={row} />
      <span
        className="script-diff-number"
        aria-label={row.oldNumber ? `Old element ${row.oldNumber}` : undefined}
      >
        {row.oldNumber ?? ""}
      </span>
      <span
        className="script-diff-number"
        aria-label={row.newNumber ? `New element ${row.newNumber}` : undefined}
      >
        {row.newNumber ?? ""}
      </span>
      <span className="script-diff-sign" aria-label={SIGN[row.kind].label}>
        {SIGN[row.kind].sign}
      </span>
      <div className="script-diff-content">
        {row.title && (
          <span className="script-diff-title-label">
            {row.label ?? "Title"}
          </span>
        )}
        <div
          className={`block${row.title ? " script-diff-title" : ""}`}
          data-type={row.block.type}
        >
          {row.segments
            ? row.segments.map((segment, i) =>
                segment.kind === "added" ? (
                  <ins key={i} className="script-diff-ins">
                    {segment.text}
                  </ins>
                ) : segment.kind === "removed" ? (
                  <del key={i} className="script-diff-del">
                    {segment.text}
                  </del>
                ) : (
                  <span key={i}>{segment.text}</span>
                ),
              )
            : row.block.text || "\u00a0"}
        </div>
      </div>
    </div>
  );
}
export function ScreenplayDiff({
  before,
  after,
  collapse = true,
  notes,
}: {
  before?: Draft | null;
  after?: Draft | null;
  collapse?: boolean;
  /** Show and take notes on the new side's lines (merge review). */
  notes?: DiffNotes;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const threads = useMemo(
    () => byBlock(notes?.comments ?? []),
    [notes?.comments],
  );
  const context = useMemo(
    () => (notes ? { notes, threads, open, setOpen } : null),
    [notes, threads, open],
  );
  const rows = useMemo(
    () => (before && after ? screenplayDiff(before, after) : null),
    [before, after],
  );
  const sections = useMemo(
    () =>
      rows
        ? collapse
          ? foldDiff(rows)
          : [{ kind: "rows" as const, rows }]
        : [],
    [rows, collapse],
  );
  if (!rows) return <TypewriterLoader contained />;
  return (
    <NotesContext.Provider value={context}>
      <div
        className={`script-diff${notes ? " has-notes" : ""}`}
        aria-label="Screenplay changes"
      >
        <div className="script-diff-legend">
          <span>− Removed</span>
          <span>+ Added</span>
          <span>± Edited in place</span>
          <span>Gutter numbers identify screenplay elements</span>
        </div>
        <div
          className="script-diff-scroll"
          tabIndex={0}
          aria-label="Formatted screenplay diff"
        >
          <div className="script-diff-sheet">
            {sections.map((section, index) =>
              section.kind === "fold" ? (
                <details className="script-diff-fold" key={index}>
                  <summary>
                    ↕ {section.rows.length} unchanged elements — expand /
                    collapse
                  </summary>
                  {section.rows.map((row, i) => (
                    <Row key={i} row={row} />
                  ))}
                </details>
              ) : (
                <div key={index}>
                  {section.rows.map((row, i) => (
                    <Row key={i} row={row} />
                  ))}
                </div>
              ),
            )}
            {!rows.length && (
              <p className="script-diff-empty">No screenplay elements.</p>
            )}
          </div>
        </div>
      </div>
    </NotesContext.Provider>
  );
}
