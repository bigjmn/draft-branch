export const ELEMENT_LABELS = {
  scene: "Scene heading",
  action: "Action",
  character: "Character",
  dialogue: "Dialogue",
  parenthetical: "Parenthetical",
  shot: "Shot",
  transition: "Transition",
} as const;
export type ElementType = keyof typeof ELEMENT_LABELS;
export interface ScriptBlock {
  id: string;
  type: ElementType;
  text: string;
}
/** The cover page, versioned with the screenplay. */
export interface TitlePage {
  title: string;
  /** e.g. "written by". */
  credit: string;
  authors: string;
  /** Bottom-left block: company, address, phone, email. */
  contact: string;
}
export interface Draft {
  title: string;
  blocks: ScriptBlock[];
  /** Missing on drafts made before title pages existed. */
  titlePage?: TitlePage;
}
export interface Scene {
  id: string;
  title: string;
  page: number;
}
export interface EditorLayout {
  pages: number;
  scenes: Scene[];
}
/** Element created by Enter. Tab can then cycle it within its TAB_CYCLES group. */
export const NEXT_ELEMENT: Record<ElementType, ElementType> = {
  scene: "action",
  action: "action",
  character: "dialogue",
  dialogue: "action",
  parenthetical: "dialogue",
  shot: "action",
  transition: "scene",
};
/** Tab / Shift+Tab cycle within the group containing the current element. */
export const TAB_CYCLES: readonly (readonly ElementType[])[] = [
  ["action", "character", "transition", "scene"],
  ["dialogue", "parenthetical"],
];
export function cycleElement(
  type: ElementType,
  direction: 1 | -1,
): ElementType {
  const cycle = TAB_CYCLES.find((group) => group.includes(type));
  // Elements outside every cycle (shot) re-enter at the default line type.
  if (!cycle) return TAB_CYCLES[0][0];
  return cycle[(cycle.indexOf(type) + direction + cycle.length) % cycle.length];
}

export interface TextWithCaret {
  text: string;
  offset: number;
}
/** Adds whichever enclosing parenthesis is missing, keeping the caret on the same character. */
export function wrapParenthetical({
  text,
  offset,
}: TextWithCaret): TextWithCaret {
  const open = text.startsWith("(") ? "" : "(";
  const close = text.endsWith(")") ? "" : ")";
  return { text: open + text + close, offset: offset + open.length };
}
/** Removes enclosing parentheses, keeping the caret on the same character. */
export function unwrapParenthetical({
  text,
  offset,
}: TextWithCaret): TextWithCaret {
  const open = text.startsWith("(") ? 1 : 0;
  const close = text.length > open && text.endsWith(")") ? 1 : 0;
  const inner = text.slice(open, text.length - close);
  return {
    text: inner,
    offset: Math.min(Math.max(offset - open, 0), inner.length),
  };
}
export const STORAGE_KEY = "draftbranch.editor.v1";
export function isElementType(value: unknown): value is ElementType {
  return typeof value === "string" && Object.hasOwn(ELEMENT_LABELS, value);
}
