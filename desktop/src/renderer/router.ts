/** A very small client-side router over the History API. The desktop app has
 * a handful of screens, and the shared components navigate with plain URLs. */
import { useSyncExternalStore } from "react";

const CHANGE = "draftbranch:navigate";
const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(CHANGE, listener);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

export function useLocation(): { pathname: string; search: string } {
  const value = useSyncExternalStore(subscribe, snapshot);
  const at = value.indexOf("?");
  return at === -1
    ? { pathname: value, search: "" }
    : { pathname: value.slice(0, at), search: value.slice(at) };
}
export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === snapshot()) return;
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
}
export const editorHref = (projectId: string, branch?: string) =>
  `/editor?project=${encodeURIComponent(projectId)}` +
  (branch ? `&branch=${encodeURIComponent(branch)}` : "");
