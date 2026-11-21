import type { ScriptBlock } from "@/lib/editor/types";
/** Compare what the editor renders, without suppressing whitespace or prose edits.
 * Legacy saves may have applied CSS uppercase through innerText. */
export function sameScreenplayElement(a: ScriptBlock, b: ScriptBlock): boolean {
  if (a.type !== b.type) return false;
  const text = (block: ScriptBlock) => {
    const value = block.text.replace(/\r\n?/g, "\n");
    return ["scene", "character", "shot", "transition"].includes(block.type)
      ? value.toUpperCase()
      : value;
  };
  return text(a) === text(b);
}
