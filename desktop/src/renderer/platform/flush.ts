/** Unsaved writing that must reach the disk before the window goes away.
 * Editors register a function here; the app runs them all when the window is
 * closing or the page is being left. */
const flushers = new Set<() => Promise<void> | void>();

export function registerFlush(flush: () => Promise<void> | void): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}
export async function flushAll(): Promise<void> {
  await Promise.allSettled([...flushers].map((flush) => flush()));
}
// Leaving the page (a reload, or a plain link) does not wait for anything, but
// a save request sent now is still carried out by the main process.
window.addEventListener("pagehide", () => void flushAll());
