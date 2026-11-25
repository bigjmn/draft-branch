"use client";
import type {
  BranchAccessInfo,
  MemberAccess,
} from "@/lib/projects/permissions";
import { readStoredValue } from "@/lib/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseDraft } from "@/lib/editor/draft";
import { projectStorageKey } from "@/lib/projects/routes";
import {
  uploadProjectDraft,
  watchUpload,
  type CloudDraft,
} from "@/lib/projects/client";
import type { Draft } from "@/lib/editor/types";
export interface EditorProject {
  id: string;
  uid: string;
  initial: CloudDraft;
  branch: string;
  role: string;
  /** Your membership: role plus editor options. */
  member?: MemberAccess;
  /** The open branch: protected, who made it, who it's dedicated to. */
  branchInfo?: BranchAccessInfo;
  /** You can write in the project but not on this branch: the pages are
   * read-only, while branching and merging stay available. */
  locked?: boolean;
}
/** Save one version at a time. Never retry a conflict by overwriting newer work. */
export function useProjectDraft(project: EditorProject) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [recoveryError, setError] = useState<string | null>(null);
  const current = useRef<Draft>(project.initial.draft);
  const version = useRef(project.initial.version);
  const dirty = useRef(false);
  const busy = useRef(false);
  const blocked = useRef(false);
  const mounted = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const key = projectStorageKey(project.uid, project.id, project.branch);
  const cache = useCallback(() => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          draft: current.current,
          version: version.current,
          baseCommit: project.initial.baseCommit,
          dirty: dirty.current,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }, [key, project.initial.baseCommit]);
  const save = useCallback(() => {
    if (blocked.current) return false;
    cache();
    if (!dirty.current || busy.current || blocked.current)
      return !blocked.current;
    busy.current = true;
    setStatus("saving");
    const snapshot = current.current;
    const failed = (message: string) => {
      busy.current = false;
      blocked.current = true;
      if (mounted.current) {
        setStatus("error");
        setError(message);
      }
      cache();
    };
    void uploadProjectDraft({
      projectId: project.id,
      branchId: project.branch,
      baseCommit: project.initial.baseCommit,
      expectedVersion: version.current,
      draft: snapshot,
      requestId: crypto.randomUUID(),
    })
      .then((ticket) => {
        if (!mounted.current) {
          busy.current = false;
          return;
        }
        stop.current = watchUpload(
          project.id,
          ticket.uploadId,
          (result) => {
            if (result.status === "awaiting_upload") return;
            stop.current?.();
            stop.current = null;
            if (result.status !== "accepted" || result.version === undefined) {
              failed(
                "Cloud save stopped: the draft changed or your access changed. Your local recovery copy is preserved. Export your writing before reloading.",
              );
              return;
            }
            version.current = result.version;
            busy.current = false;
            dirty.current = current.current !== snapshot;
            cache();
            if (mounted.current) setStatus(dirty.current ? "saving" : "saved");
          },
          () =>
            failed(
              "Cloud save couldn’t be confirmed. Your recovery copy is preserved. Export your writing before reloading.",
            ),
        );
      })
      .catch(() =>
        failed(
          "Cloud save failed. Your recovery copy is preserved. Check your connection; export your writing before reloading.",
        ),
      );
    return true;
  }, [cache, project.id, project.branch, project.initial.baseCommit]);
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = readStoredValue(localStorage, key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.dirty) {
          const recovered = parseDraft(JSON.stringify(saved.draft));
          current.current = recovered;
          setDraft(recovered);
          dirty.current = true;
          if (
            saved.version !== version.current ||
            saved.baseCommit !== project.initial.baseCommit
          ) {
            blocked.current = true;
            setStatus("error");
            setError(
              "Recovered unsaved writing, but the cloud version has changed. Export this recovery copy before reloading or reconciling it.",
            );
          }
        }
      }
    } catch {
      blocked.current = true;
      setStatus("error");
      setError(
        "The local recovery copy could not be read. It has been preserved; cloud saving is paused.",
      );
    }
    setDraft(current.current);
    const tick = setInterval(() => {
      if (dirty.current && !busy.current && !blocked.current) save();
    }, 1500);
    const hidden = () => {
      if (dirty.current && !blocked.current) cache();
    };
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", hidden);
    window.addEventListener("beforeunload", leaving);
    return () => {
      mounted.current = false;
      clearInterval(tick);
      stop.current?.();
      if (dirty.current && !blocked.current) cache();
      window.removeEventListener("pagehide", hidden);
      window.removeEventListener("beforeunload", leaving);
    };
  }, [key, cache, save, project.initial.baseCommit]);
  const update = useCallback(
    (next: Draft) => {
      current.current = next;
      dirty.current = true;
      setDraft(next);
      if (!blocked.current) setStatus("saving");
      if (!blocked.current && !cache()) {
        setStatus("error");
        setError(
          "Local recovery is unavailable. Keep this tab open until cloud saving completes, or export a copy.",
        );
      }
    },
    [cache],
  );
  return {
    draft,
    status,
    recoveryError,
    update,
    save,
    getVersion: () => version.current,
    canPublish: () => !dirty.current && !busy.current && !blocked.current,
  };
}
