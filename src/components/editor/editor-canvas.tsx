"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ScreenplayEngine } from "@/lib/editor/engine";
import type {
  EditorLayout,
  ElementType,
  ScriptBlock,
} from "@/lib/editor/types";

export interface CanvasHandle {
  focus: (id: string) => void;
  append: (type: ElementType) => void;
  setType: (type: ElementType) => void;
  paginate: () => void;
}
interface Props {
  initialBlocks: ScriptBlock[];
  onChange: (blocks: ScriptBlock[]) => void;
  onSelection: (id: string, type: ElementType) => void;
  onLayout: (layout: EditorLayout) => void;
}
export const EditorCanvas = forwardRef<CanvasHandle, Props>(
  function EditorCanvas(props, ref) {
    const root = useRef<HTMLDivElement>(null);
    const engine = useRef<ScreenplayEngine | null>(null);
    const latest = useRef(props);
    useEffect(() => {
      latest.current = props;
    });
    useImperativeHandle(
      ref,
      () => ({
        focus: (id) => engine.current?.focus(id),
        append: (type) => engine.current?.append(type),
        setType: (type) => engine.current?.setType(type),
        paginate: () => engine.current?.paginate(),
      }),
      [],
    );
    useEffect(() => {
      if (!root.current) return;
      engine.current = new ScreenplayEngine(
        root.current,
        latest.current.initialBlocks,
        {
          onChange: (blocks) => latest.current.onChange(blocks),
          onSelection: (id, type) => latest.current.onSelection(id, type),
          onLayout: (layout) => latest.current.onLayout(layout),
        },
      );
      return () => {
        engine.current?.destroy();
        engine.current = null;
      };
    }, []);
    return <div id="pages" ref={root} aria-label="Screenplay pages" />;
  },
);
