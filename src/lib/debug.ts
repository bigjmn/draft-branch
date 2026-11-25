/**
 * Console logging for tracing sign-in, redirects and loading.
 *
 * On by default in development. In production, turn it on by opening any
 * page with `?debug` in the URL (it sticks for that browser), or by running
 * `localStorage.setItem("draftbranch.debug", "1")` in the console and
 * reloading. Turn it off with `localStorage.removeItem("draftbranch.debug")`.
 *
 * Warnings about something taking too long (see `watchSlow`) are always
 * printed, debug mode or not, because they're what you need when a page hangs.
 */
const KEY = "draftbranch.debug";
let enabled: boolean | undefined;

export function debugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (enabled !== undefined) return enabled;
  try {
    if (new URLSearchParams(window.location.search).has("debug"))
      localStorage.setItem(KEY, "1");
    enabled =
      process.env.NODE_ENV !== "production" ||
      localStorage.getItem(KEY) === "1";
  } catch {
    enabled = process.env.NODE_ENV !== "production";
  }
  return enabled;
}

export type DebugArea = "auth" | "route" | "data";
const COLORS: Record<DebugArea, string> = {
  auth: "#0d9488",
  route: "#7c3aed",
  data: "#2563eb",
};

/** Milliseconds since the page started loading, so log lines show timing. */
const since = () =>
  typeof performance === "undefined" ? 0 : Math.round(performance.now());

export function debugLog(
  area: DebugArea,
  message: string,
  details?: Record<string, unknown>,
) {
  if (!debugEnabled()) return;
  console.info(
    `%c[${area}]%c +${since()}ms ${message}`,
    `color:${COLORS[area]};font-weight:600`,
    "color:inherit",
    ...(details ? [details] : []),
  );
}

/**
 * Start timing something the page waits on. If `done()` isn't called within
 * `ms`, a warning names it, so a stuck loading screen says what it's stuck on.
 */
export function watchSlow(
  area: DebugArea,
  label: string,
  ms = 6000,
): (outcome?: string) => void {
  const started = since();
  debugLog(area, `${label}: started`);
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished)
      console.warn(
        `[${area}] Still waiting after ${ms / 1000}s: ${label}. ` +
          "Open the page with ?debug for a full trace.",
      );
  }, ms);
  return (outcome = "done") => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    debugLog(area, `${label}: ${outcome} after ${since() - started}ms`);
  };
}

/** The parts of a Firebase user worth logging; never tokens or emails. */
export function describeUser(
  user: {
    uid: string;
    isAnonymous: boolean;
    emailVerified?: boolean;
    providerData?: { providerId: string }[];
  } | null,
) {
  if (!user) return { signedIn: false };
  return {
    signedIn: true,
    uid: user.uid,
    anonymous: user.isAnonymous,
    emailVerified: user.emailVerified,
    providers: user.providerData?.map((p) => p.providerId) ?? [],
  };
}
