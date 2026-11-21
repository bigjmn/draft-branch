import { sameScreenplayElement } from "./element-equality";
import type { Draft, ScriptBlock } from "@/lib/editor/types";
export interface DraftChange {
  id: string;
  isTitle?: boolean;
  kind: "added" | "removed" | "modified" | "moved";
  before?: ScriptBlock;
  after?: ScriptBlock;
}
/** Compare stable block identities; insertion alone does not mark every later block moved. */
export function draftChanges(before: Draft, after: Draft): DraftChange[] {
  const old = new Map(before.blocks.map((b) => [b.id, b]));
  const next = new Map(after.blocks.map((b) => [b.id, b]));
  const oldShared = before.blocks
    .filter((b) => next.has(b.id))
    .map((b) => b.id);
  const newShared = after.blocks.filter((b) => old.has(b.id)).map((b) => b.id);
  const oldOrder = new Map(oldShared.map((id, i) => [id, i]));
  const newOrder = new Map(newShared.map((id, i) => [id, i]));
  const changes: DraftChange[] = [];
  if (before.title !== after.title)
    changes.push({
      id: "title",
      isTitle: true,
      kind: "modified",
      before: { id: "title", type: "action", text: before.title },
      after: { id: "title", type: "action", text: after.title },
    });
  for (const b of after.blocks) {
    const a = old.get(b.id);
    if (!a) changes.push({ id: b.id, kind: "added", after: b });
    else if (!sameScreenplayElement(a, b))
      changes.push({ id: b.id, kind: "modified", before: a, after: b });
    else if (oldOrder.get(b.id) !== newOrder.get(b.id))
      changes.push({ id: b.id, kind: "moved", before: a, after: b });
  }
  for (const a of before.blocks)
    if (!next.has(a.id)) changes.push({ id: a.id, kind: "removed", before: a });
  return changes;
}
