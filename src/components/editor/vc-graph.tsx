"use client";
import { useMemo } from "react";
import type { Branch, RevisionSummary } from "@/lib/projects/client";
import {
  graphWidth,
  layoutGraph,
  LANE_COLORS,
  type GraphRow,
} from "@/lib/projects/graph";

const LANE = 14;
const ROW = 34;
const MID = ROW / 2;
const x = (lane: number) => 9 + lane * LANE;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  x1 === x2
    ? `M${x1} ${y1}V${y2}`
    : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;

export interface Author {
  name: string;
  color: number;
  initials: string;
}
export function authorBadge(uid: string, name: string): Author {
  let h = 0;
  for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials =
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?";
  return { name, color: h % LANE_COLORS, initials };
}

function Lanes({ row, width }: { row: GraphRow; width: number }) {
  return (
    <svg
      className="vc-lanes"
      width={x(width - 1) + 9}
      height={ROW}
      aria-hidden="true"
    >
      {row.segments.map((s, i) => (
        <path
          key={i}
          className={`lane-${s.color}`}
          d={
            s.kind === "pass"
              ? `M${x(s.lane)} 0V${ROW}`
              : s.kind === "in"
                ? curve(x(s.from), 0, x(s.to), MID)
                : curve(x(s.from), MID, x(s.to), ROW)
          }
        />
      ))}
      <circle
        className={`lane-${row.color}${row.merge ? " merge" : ""}`}
        cx={x(row.lane)}
        cy={MID}
        r={row.merge ? 5 : 4.5}
      />
    </svg>
  );
}

const when = (seconds: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(seconds * 1000);

export function CommitGraph({
  commits,
  branches,
  checkedOut,
  selected,
  onSelect,
  working,
  onWorking,
  author,
}: {
  /** Already ordered (orderCommits) and filtered to the visible scope. */
  commits: RevisionSummary[];
  branches: Branch[];
  checkedOut: string;
  selected: string | null;
  onSelect: (commit: RevisionSummary) => void;
  /** Number of uncommitted element changes, or null to hide the row. */
  working: number | null;
  onWorking: () => void;
  author: (commit: RevisionSummary) => Author;
}) {
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = graphWidth(rows);
  const refs = useMemo(() => {
    const map = new Map<string, Branch[]>();
    for (const b of branches) map.set(b.head, [...(map.get(b.head) ?? []), b]);
    return map;
  }, [branches]);
  const headLane =
    rows.find(
      (r) => r.oid === branches.find((b) => b.name === checkedOut)?.head,
    )?.lane ?? 0;
  return (
    <div className="vc-log" role="table" aria-label="Commit graph">
      <div className="vc-log-row vc-log-head" role="row">
        <span role="columnheader">Branch</span>
        <span role="columnheader" className="vc-log-graph">
          Graph
        </span>
        <span role="columnheader">
          Message <small>{commits.length} revisions</small>
        </span>
        <span role="columnheader">Author</span>
        <span role="columnheader">Date</span>
        <span role="columnheader">Revision</span>
      </div>
      {working !== null && (
        <button
          className="vc-log-row vc-log-working"
          role="row"
          onClick={onWorking}
        >
          <span />
          <span className="vc-log-graph">
            <svg
              className="vc-lanes"
              width={x(width - 1) + 9}
              height={ROW}
              aria-hidden="true"
            >
              <path
                className="lane-working"
                d={`M${x(headLane)} ${MID + 5}V${ROW}`}
              />
              <circle
                className="lane-working"
                cx={x(headLane)}
                cy={MID}
                r={5}
              />
            </svg>
          </span>
          <span className="vc-log-message">
            Uncommitted changes
            <small>{working === 0 ? "clean" : `${working} changed`}</small>
          </span>
          <span />
          <span />
          <code>working</code>
        </button>
      )}
      {commits.map((commit, i) => {
        const who = author(commit);
        return (
          <button
            key={commit.oid}
            role="row"
            className={`vc-log-row${selected === commit.oid ? " selected" : ""}${commit.parent.length > 1 ? " is-merge" : ""}`}
            onClick={() => onSelect(commit)}
          >
            <span className="vc-log-refs">
              {refs.get(commit.oid)?.map((b) => (
                <span
                  key={b.name}
                  className={`vc-ref${b.name === checkedOut ? " head" : ""}`}
                  title={b.name === checkedOut ? "Checked out" : undefined}
                >
                  {b.protected && <span aria-label="protected">🔒</span>}
                  {b.name}
                </span>
              ))}
            </span>
            <span className="vc-log-graph">
              <Lanes row={rows[i]} width={width} />
            </span>
            <span className="vc-log-message">{commit.message}</span>
            <span className="vc-log-author">
              <span className={`vc-avatar lane-bg-${who.color}`}>
                {who.initials}
              </span>
              {who.name}
            </span>
            <span className="vc-log-date">{when(commit.timestamp)}</span>
            <code>{commit.oid.slice(0, 7)}</code>
          </button>
        );
      })}
    </div>
  );
}
