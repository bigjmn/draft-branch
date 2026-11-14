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
export interface Draft {
  title: string;
  blocks: ScriptBlock[];
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
export const NEXT_ELEMENT: Record<ElementType, ElementType> = {
  scene: "action",
  action: "action",
  character: "dialogue",
  dialogue: "character",
  parenthetical: "dialogue",
  shot: "action",
  transition: "scene",
};
export const STORAGE_KEY = "scriptroom.editor.v1";
export function isElementType(value: unknown): value is ElementType {
  return typeof value === "string" && Object.hasOwn(ELEMENT_LABELS, value);
}
