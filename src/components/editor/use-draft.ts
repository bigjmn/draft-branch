"use client";
import { readStoredValue } from "@/lib/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseDraft } from "@/lib/editor/draft";
import { createBlankDraft, createSampleDraft } from "@/lib/editor/sample";
import { STORAGE_KEY, type Draft } from "@/lib/editor/types";

export type SaveStatus = "loading" | "saved" | "saving" | "error";

export function useDraft() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const current = useRef<Draft | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fresh = useRef<boolean | null>(null);

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
    // `/editor?new` opens a blank project. Drop the flag so a reload keeps the
    // user's work. The blank draft replaces the stored one on the first edit.
    // The answer is kept in a ref because Strict Mode runs this effect twice,
    // and the second run would no longer see the flag.
    const url = new URL(window.location.href);
    fresh.current ??= url.searchParams.has("new");
    if (url.searchParams.has("new")) {
      url.searchParams.delete("new");
      window.history.replaceState(window.history.state, "", url);
    }
    try {
      const raw = fresh.current
        ? null
        : readStoredValue(localStorage, STORAGE_KEY);
      if (fresh.current) initial = createBlankDraft();
      else if (raw) initial = parseDraft(raw);
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
