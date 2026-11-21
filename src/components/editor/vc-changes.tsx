"use client";
import {
  ELEMENT_LABELS,
  type Draft,
  type ElementType,
} from "@/lib/editor/types";

export const elementLabel = (type: string) =>
  type === "title"
    ? "Title"
    : (ELEMENT_LABELS[type as ElementType] ?? "Element");

/** Scene heading text that each element sits under, for locating changes. */
export function sceneIndex(...drafts: Draft[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const draft of drafts) {
    let scene = "Before the first scene";
    for (const block of draft.blocks) {
      if (block.type === "scene") scene = block.text || "Untitled scene";
      if (!result.has(block.id)) result.set(block.id, scene);
    }
  }
  return result;
}

export { ScreenplayDiff as ChangeList } from "./screenplay-diff";
