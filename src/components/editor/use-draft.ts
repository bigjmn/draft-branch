"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseDraft } from "@/lib/editor/draft";
import { createSampleDraft } from "@/lib/editor/sample";
import { STORAGE_KEY, type Draft } from "@/lib/editor/types";

export type SaveStatus = "loading" | "saved" | "saving" | "error";

export function useDraft() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const current = useRef<Draft | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(() => {
    if (!current.current || !dirty.current) return true;
    if (timer.current) clearTimeout(timer.current);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current.current));
      dirty.current = false;
      setStatus("saved");
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, []);

  useEffect(() => {
    let initial = createSampleDraft();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) initial = parseDraft(raw);
      setStatus("saved");
    } catch {
      setRecoveryError(
        "Your saved draft could not be loaded. It has not been overwritten. Export or recover it before editing this sample.",
      );
      setStatus("error");
    }
    current.current = initial;
    setDraft(initial);
    const onHidden = () => {
      if (document.hidden) save();
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      save();
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [save]);

  const update = useCallback(
    (next: Draft) => {
      current.current = next;
      dirty.current = true;
      setDraft(next);
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, 250);
    },
    [save],
  );

  return { draft, status, recoveryError, update, save };
}
