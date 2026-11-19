/** Read legacy local data without overwriting it; new saves use the new namespace. */
const LEGACY_STORAGE_PREFIX = "scriptroom.";
export function readStoredValue(
  storage: Pick<Storage, "getItem">,
  key: string,
): string | null {
  return (
    storage.getItem(key) ??
    storage.getItem(key.replace(/^draftbranch\./, LEGACY_STORAGE_PREFIX))
  );
}

/** Runs before paint to preserve the saved theme, including the legacy namespace. */
export const THEME_BOOTSTRAP = `try{document.documentElement.dataset.theme=(localStorage.getItem("draftbranch.theme")??localStorage.getItem("${LEGACY_STORAGE_PREFIX}theme"))==="light"?"light":"dark"}catch{}`;
