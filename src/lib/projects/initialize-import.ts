import type { Draft } from "@/lib/editor/types";
interface Loaded {
  draft: Draft;
  version: number;
  head: string;
  baseCommit: string;
}
/** Verify persistence before navigation; older deployments ignored create.draft.
 * Only repair a pristine initial draft, never overwrite existing writing. */
export async function initializeImportedProject(
  initialHead: string,
  draft: Draft,
  load: () => Promise<Loaded>,
  save: (loaded: Loaded) => Promise<{ status: string }>,
) {
  const matches = (value: Loaded) =>
    value.draft.title === draft.title &&
    JSON.stringify(value.draft.blocks) === JSON.stringify(draft.blocks);
  const existing = await load();
  if (matches(existing)) return;
  if (
    existing.version !== 0 ||
    existing.head !== initialHead ||
    existing.baseCommit !== initialHead ||
    existing.draft.blocks.length !== 1 ||
    existing.draft.blocks[0].text.trim()
  )
    throw new Error(
      "The new project contains different writing. Import was stopped to protect it.",
    );
  const result = await save(existing);
  if (result.status !== "accepted" || !matches(await load()))
    throw new Error(
      "The imported screenplay could not be confirmed. Please retry; your selected file is still available.",
    );
}
