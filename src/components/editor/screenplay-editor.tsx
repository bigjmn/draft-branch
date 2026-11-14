"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadDraft, wordCount } from "@/lib/editor/draft";
import {
  ELEMENT_LABELS,
  type EditorLayout,
  type ElementType,
  type ScriptBlock,
} from "@/lib/editor/types";
import { EditorCanvas, type CanvasHandle } from "./editor-canvas";
import { EditorDialog, type DialogKind } from "./editor-dialog";
import { Sidebar } from "./sidebar";
import { Toolbar } from "./toolbar";
import { useDraft } from "./use-draft";

export function ScreenplayEditor() {
  const { draft, status, recoveryError, update, save } = useDraft();
  const canvas = useRef<CanvasHandle>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [layout, setLayout] = useState<EditorLayout>({ pages: 1, scenes: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [type, setType] = useState<ElementType>("scene");
  const [zoom, setZoom] = useState("fit");
  const [focus, setFocus] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [toast, setToast] = useState("");
  const hydratedTitle = useRef(false);

  useEffect(() => {
    if (!draft) return;
    document.title = `${draft.title} — Scriptroom`;
    if (title.current && !hydratedTitle.current) {
      title.current.textContent = draft.title;
      hydratedTitle.current = true;
    }
  }, [draft]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        setToast(
          save()
            ? "Draft saved on this device."
            : "Unable to save. Export a copy to keep your work.",
        );
      }
      if (event.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  const onSelection = useCallback((id: string, next: ElementType) => {
    setSelectedId(id);
    setType(next);
  }, []);
  const onBlocks = useCallback(
    (blocks: ScriptBlock[]) => {
      if (draft) update({ ...draft, blocks });
    },
    [draft, update],
  );
  const onExport = (format: "fountain" | "json") => {
    if (draft) downloadDraft(draft, format);
    setDialog(null);
    setToast("Your screenplay has been exported.");
  };
  const onPrint = () => {
    setDialog(null);
    canvas.current?.paginate();
    // Let React close the dialog before opening the browser print sheet.
    requestAnimationFrame(() => window.print());
  };
  if (!draft)
    return (
      <main className="loading-state" role="status">
        Opening your writing room…
      </main>
    );

  return (
    <div className={`editor-shell${focus ? " focus" : ""}`} data-zoom={zoom}>
      <Sidebar
        title={draft.title}
        scenes={layout.scenes}
        selectedId={selectedId}
        onScene={(id) => canvas.current?.focus(id)}
        onAdd={() => canvas.current?.append("scene")}
        onHelp={() => setDialog("help")}
      />
      <div id="app">
        <header>
          <div className="breadcrumb">
            {draft.title} <span>/</span> <strong>Screenplay</strong>
          </div>
          <div className="header-actions">
            <span id="saveStatus" role="status">
              {status === "saved" && <i />}
              {status === "saving"
                ? "Saving…"
                : status === "error"
                  ? "Not saved — export a copy"
                  : "Saved locally"}
            </span>
            <button className="button" onClick={() => setDialog("export")}>
              Export <span>↗</span>
            </button>
          </div>
        </header>
        <section className="document-header">
          <div>
            <div className="eyebrow">WORKING DRAFT</div>
            <h1
              ref={title}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              aria-label="Screenplay title"
              onInput={(event) =>
                update({
                  ...draft,
                  title: event.currentTarget.textContent ?? "",
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                const text =
                  event.currentTarget.textContent?.trim() ||
                  "Untitled screenplay";
                event.currentTarget.textContent = text;
                update({ ...draft, title: text });
              }}
            />
            <p>A little space for your next great story.</p>
          </div>
          <div className="draft-label">
            <span className="branch-symbol">⑂</span> Main draft{" "}
            <span className="local-badge">LOCAL</span>
          </div>
        </section>
        <Toolbar
          type={type}
          zoom={zoom}
          focus={focus}
          onType={(next) => canvas.current?.setType(next)}
          onZoom={setZoom}
          onFocus={() => setFocus((value) => !value)}
        />
        {recoveryError && (
          <p className="recovery-banner" role="alert">
            {recoveryError}
          </p>
        )}
        <main id="canvas">
          <div className="paper-caption">
            <span>SCREENPLAY</span>
            <span>US LETTER · 8.5 × 11 IN</span>
          </div>
          <EditorCanvas
            ref={canvas}
            initialBlocks={draft.blocks}
            onChange={onBlocks}
            onSelection={onSelection}
            onLayout={setLayout}
          />
          <button
            className="add-block"
            onClick={() => canvas.current?.append("action")}
          >
            + Add a new element
          </button>
          <div className="paper-note">
            A place for the story. Everything else can wait.
          </div>
        </main>
        <footer>
          <span>
            <i />
            {layout.pages} {layout.pages === 1 ? "page" : "pages"} ·{" "}
            {wordCount(draft)} words
          </span>
          <span>{ELEMENT_LABELS[type]}</span>
          <span>
            <kbd>Tab</kbd> Change element <b>·</b> <kbd>Enter</kbd> Next element
          </span>
        </footer>
      </div>
      <EditorDialog
        kind={dialog}
        onClose={() => setDialog(null)}
        onExport={onExport}
        onPrint={onPrint}
      />
      <div id="toast" className={toast ? "visible" : ""} role="status">
        {toast}
      </div>
    </div>
  );
}
