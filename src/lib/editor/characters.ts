import type { ScriptBlock } from "./types";

const nameOf = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\(CONT[’']?D\)$/i, "")
    .toUpperCase();
/** Suggestions are derived from the draft, never inserted until accepted. */
export function characterSuggestions(
  blocks: ScriptBlock[],
  activeId: string,
  input: string,
): string[] {
  const index = blocks.findIndex((b) => b.id === activeId);
  const names = [
    ...new Set(
      blocks
        .filter((b) => b.type === "character" && b.id !== activeId)
        .map((b) => nameOf(b.text))
        .filter(Boolean),
    ),
  ];
  const spoken: ScriptBlock[] = [];
  let cue: ScriptBlock | undefined;
  for (const block of blocks.slice(0, index)) {
    if (block.type === "character") cue = block;
    else if (block.type === "dialogue" && block.text.trim() && cue) {
      spoken.push(cue);
      cue = undefined;
    } else if (block.type !== "parenthetical") cue = undefined;
  }
  const preferred =
    spoken.length >= 2 ? nameOf(spoken.at(-2)!.text) : undefined;
  const prefix = input.trim().toUpperCase();
  if (!prefix) return preferred ? [preferred] : [];
  return names
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) =>
      a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b),
    );
}
