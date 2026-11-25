"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { byBlock, type ScriptComment } from "@/lib/projects/comments";
import {
  CommentIcon,
  CommentThread,
  type CommentPermissions,
} from "./comment-thread";

/** Distance of the icon from the page's left edge, in screen pixels. */
const ICON_INSET = 22;
const THREAD_WIDTH = 300;

interface Mark {
  top: number;
  left: number;
  /** The page's edges, for placing the thread beside the paper. */
  pageLeft: number;
  pageRight: number;
  /** Room to the right of the page. */
  spaceRight: number;
  height: number;
}

/**
 * WriterDuet-style notes in the left margin of the pages. Hovering a line
 * shows a faint note icon beside it; lines with notes keep a solid one.
 * Clicking either opens that line's thread. Rendered inside `host`, a
 * positioned wrapper around the editor's #pages.
 */
export function CommentMargin({
  host,
  projectId,
  branch,
  comments,
  permissions,
  open,
  onOpen,
  layoutKey,
}: {
  host: React.RefObject<HTMLDivElement | null>;
  projectId: string;
  branch: string;
  comments: ScriptComment[];
  permissions: CommentPermissions;
  /** The line whose thread is open. */
  open: string | null;
  onOpen: (blockId: string | null) => void;
  /** Changes when the pages are laid out again (pagination, zoom). */
  layoutKey?: unknown;
}) {
  const threads = useMemo(() => byBlock(comments), [comments]);
  const pinned = useMemo(
    () =>
      [...threads]
        .filter(([, list]) => list.some((c) => !c.resolved))
        .map(([id]) => id),
    [threads],
  );
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [hover, setHover] = useState<{ id: string; mark: Mark } | null>(null);
  const frame = useRef(0);

  const locate = useCallback(
    (block: Element): Mark | null => {
      const box = host.current?.getBoundingClientRect();
      const page = block.closest(".page")?.getBoundingClientRect();
      if (!box || !page) return null;
      const rect = block.getBoundingClientRect();
      const line = Math.min(
        rect.height,
        parseFloat(getComputedStyle(block).lineHeight) || 16,
      );
      return {
        top: rect.top - box.top + Math.max(0, (line - 20) / 2),
        left: page.left - box.left + ICON_INSET,
        pageLeft: page.left - box.left,
        pageRight: page.right - box.left,
        spaceRight: box.right - page.right,
        height: rect.height,
      };
    },
    [host],
  );
  const find = useCallback(
    (id: string) =>
      host.current?.querySelector(`.block[data-id="${CSS.escape(id)}"]`) ??
      null,
    [host],
  );

  // Where every pinned line (and the open one) sits right now.
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next: Record<string, Mark> = {};
      for (const id of new Set([...pinned, ...(open ? [open] : [])])) {
        const block = find(id);
        const mark = block && locate(block);
        if (mark) next[id] = mark;
      }
      setMarks(next);
    });
  }, [pinned, open, find, locate]);
  useEffect(() => {
    measure();
  }, [measure, layoutKey]);
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const pages = root.querySelector("#pages") ?? root;
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    const edits = new MutationObserver(measure);
    edits.observe(pages, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener("resize", measure);
    return () => {
      resize.disconnect();
      edits.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(frame.current);
    };
  }, [host, measure]);

  // Hovering anywhere along a line, in the margin or over the text.
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const onMove = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest?.(".comment-pin, .comment-thread")) return;
      const page = target.closest?.(".page");
      let block: Element | null = target.closest?.(".block") ?? null;
      if (!block && page)
        block =
          [...page.querySelectorAll(".block")].find((b) => {
            const r = b.getBoundingClientRect();
            return event.clientY >= r.top - 6 && event.clientY <= r.bottom + 6;
          }) ?? null;
      const id = block?.getAttribute("data-id");
      if (!block || !id) return setHover(null);
      setHover((current) => {
        if (current?.id === id) return current;
        const mark = locate(block!);
        return mark ? { id, mark } : null;
      });
    };
    const onLeave = () => setHover(null);
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
    };
  }, [host, locate]);

  // Tint the line being pointed at, and more firmly the one whose notes are open.
  useEffect(() => {
    const hovered =
      hover && (permissions.canComment || threads.has(hover.id))
        ? find(hover.id)
        : null;
    const active = open ? find(open) : null;
    hovered?.classList.add("comment-hover");
    active?.classList.add("comment-open");
    return () => {
      hovered?.classList.remove("comment-hover");
      active?.classList.remove("comment-open");
    };
  }, [hover, open, find, permissions.canComment, threads, marks]);

  const showHover =
    hover &&
    !pinned.includes(hover.id) &&
    (permissions.canComment || threads.has(hover.id));
  const openMark = open ? marks[open] : null;
  const quote = open ? (find(open)?.textContent ?? "") : "";

  return (
    <div className="comment-margin" aria-label="Comments">
      {pinned.map((id) => {
        const mark = marks[id];
        if (!mark) return null;
        const count = threads.get(id)!.filter((c) => !c.resolved).length;
        return (
          <button
            key={id}
            type="button"
            data-comment-toggle
            className={`comment-pin is-set${open === id ? " is-open" : ""}`}
            style={{ top: mark.top, left: mark.left }}
            aria-label={`${count} ${count === 1 ? "comment" : "comments"} on this line`}
            aria-expanded={open === id}
            onClick={() => onOpen(open === id ? null : id)}
          >
            <CommentIcon />
            {count > 1 && <span className="comment-count">{count}</span>}
          </button>
        );
      })}
      {showHover && (
        <button
          type="button"
          data-comment-toggle
          className={`comment-pin${open === hover.id ? " is-open" : ""}`}
          style={{ top: hover.mark.top, left: hover.mark.left }}
          aria-label={
            threads.has(hover.id)
              ? "Show resolved comments"
              : "Add a comment to this line"
          }
          onClick={() => onOpen(open === hover.id ? null : hover.id)}
        >
          <CommentIcon />
        </button>
      )}
      {open && openMark && (
        <CommentThread
          key={open}
          className="comment-thread-floating"
          style={{ ...threadPosition(openMark), width: THREAD_WIDTH }}
          projectId={projectId}
          branch={branch}
          blockId={open}
          quote={quote}
          comments={threads.get(open) ?? []}
          permissions={permissions}
          onClose={() => onOpen(null)}
        />
      )}
    </div>
  );
}

/** Beside the paper when there's room (left first, like the icon), else just
 * under the line, so the line itself stays visible. */
function threadPosition(mark: Mark) {
  const room = THREAD_WIDTH + 16;
  if (mark.pageLeft >= room)
    return { top: Math.max(0, mark.top - 8), left: mark.pageLeft - room + 4 };
  if (mark.spaceRight >= room)
    return { top: Math.max(0, mark.top - 8), left: mark.pageRight + 12 };
  return { top: mark.top + mark.height + 6, left: mark.left };
}
