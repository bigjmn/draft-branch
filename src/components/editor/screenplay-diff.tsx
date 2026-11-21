"use client";
import { useMemo } from "react";
import type { Draft } from "@/lib/editor/types";
import {
  screenplayDiff,
  foldDiff,
  type DiffRow,
} from "@/lib/projects/screenplay-diff";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

function Row({ row }: { row: DiffRow }) {
  return (
    <div className={`script-diff-row script-diff-${row.kind}`}>
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
      <span
        className="script-diff-sign"
        aria-label={
          row.kind === "context"
            ? "Unchanged"
            : row.kind === "added"
              ? "Added"
              : "Removed"
        }
      >
        {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
      </span>
      <div className="script-diff-content">
        {row.title && <span className="script-diff-title-label">Title</span>}
        <div
          className={`block${row.title ? " script-diff-title" : ""}`}
          data-type={row.block.type}
        >
          {row.block.text || "\u00a0"}
        </div>
      </div>
    </div>
  );
}
export function ScreenplayDiff({
  before,
  after,
  collapse = true,
}: {
  before?: Draft | null;
  after?: Draft | null;
  collapse?: boolean;
}) {
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
    <div className="script-diff" aria-label="Screenplay changes">
      <div className="script-diff-legend">
        <span>− Removed</span>
        <span>+ Added</span>
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
                  ↕ {section.rows.length} unchanged elements — expand / collapse
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
  );
}
