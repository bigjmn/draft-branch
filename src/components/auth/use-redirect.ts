"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { debugLog } from "@/lib/debug";

/** How long a client-side redirect may take before loading the page directly. */
export const REDIRECT_FALLBACK_MS = 3000;

/**
 * Redirect once `target` is set (null means stay). Uses the router for a
 * fast client-side move, and if the address hasn't changed after
 * REDIRECT_FALLBACK_MS, loads the target directly so a stalled navigation
 * can never leave someone on a loading screen. `trigger` re-runs the
 * redirect when it changes (e.g. the auth revision after a session restore).
 */
export function useRedirect(
  target: string | null,
  reason: string,
  trigger?: unknown,
) {
  const router = useRouter();
  useEffect(() => {
    if (!target) return;
    const from = window.location.pathname + window.location.search;
    debugLog("route", `redirect ${from} → ${target}`, { reason });
    router.replace(target);
    const timer = setTimeout(() => {
      const here = window.location.pathname + window.location.search;
      if (here !== from) return;
      console.warn(
        `[route] Redirect from ${from} to ${target} (${reason}) didn’t happen within ${REDIRECT_FALLBACK_MS / 1000}s; loading ${target} directly.`,
      );
      window.location.replace(target);
    }, REDIRECT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [target, reason, router, trigger]);
}
