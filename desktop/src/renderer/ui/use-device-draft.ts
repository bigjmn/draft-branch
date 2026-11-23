/** The editor's working draft, saved to this device as you type.
 *
 * Same shape as the web app's useProjectDraft, so the shared EditorView can use
 * either. Saves are debounced, sent one at a time, and each carries the version
 * it expects to replace, so two writers of the same draft can never silently
 * overwrite each other.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorProject } from "@/components/editor/use-project-draft";
import type { Draft } from "@/lib/editor/types";
import { apiOf, emitSaved, refOf } from "../data/projects";
import { registerFlush } from "../platform/flush";

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 3000;

export function useDeviceDraft(project: EditorProject) {
  const [draft, setDraft] = useState<Draft>(project.initial.draft);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [recoveryError, setError] = useState<string | null>(null);
  const current = useRef<Draft>(project.initial.draft);
  const version = useRef(project.initial.version);
  const dirty = useRef(false);
  const writing = useRef<Promise<void> | null>(null);
  /** The draft changed underneath this editor; saving again would overwrite it. */
  const blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const api = useMemo(() => apiOf(project.id), [project.id]);
  const ref = useMemo(() => refOf(project.id), [project.id]);
  const { branch } = project;
  const { baseCommit } = project.initial;

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // One save at a time; whatever was typed meanwhile goes in the next one.
    while (writing.current) await writing.current;
    if (!dirty.current || blocked.current) return;
    const snapshot = current.current;
    dirty.current = false;
    const attempt = (async () => {
      try {
        const result = await api.saveDraft({
          branch,
          baseCommit,
          expectedVersion: version.current,
          draft: snapshot,
        });
        if (result.status === "accepted" && result.version !== undefined) {
          version.current = result.version;
          if (mounted.current) {
            setError(null);
            if (!dirty.current) setStatus("saved");
          }
          emitSaved(ref);
          return;
        }
        blocked.current = true;
        dirty.current = true;
        if (mounted.current) {
          setStatus("error");
          setError(
            result.status === "conflict"
              ? "This draft was changed outside this editor, so saving has stopped to protect both versions. Export your writing, then reopen the project."
              : (result.error ?? "This draft could not be saved.") +
                  " Export a copy to keep your latest writing.",
          );
        }
      } catch {
        // The disk refused (full, read-only, unplugged). Keep trying; the
        // writing is still in the editor.
        dirty.current = true;
        if (mounted.current) {
          setStatus("error");
          setError(
            "Couldn’t save to this device. Your writing is still here; export a copy while this is sorted out.",
          );
          timer.current = setTimeout(() => void flush(), RETRY_DELAY_MS);
        }
      }
    })();
    writing.current = attempt;
    await attempt;
    writing.current = null;
    if (dirty.current && !blocked.current && !timer.current && mounted.current)
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [api, ref, branch, baseCommit]);

  useEffect(() => {
    mounted.current = true;
    const unregister = registerFlush(flush);
    return () => {
      mounted.current = false;
      unregister();
      void flush();
    };
  }, [flush]);

  const update = useCallback(
    (next: Draft) => {
      current.current = next;
      dirty.current = true;
      setDraft(next);
      if (blocked.current) return;
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );
  const save = useCallback(() => {
    if (blocked.current) return false;
    void flush();
    return true;
  }, [flush]);

  return {
    draft,
    status,
    recoveryError,
    update,
    save,
    getVersion: () => version.current,
    /** Everything typed has reached the disk and nothing is in flight. */
    canPublish: () => !dirty.current && !writing.current && !blocked.current,
    flush,
  };
}
