"use client";
import { useEffect, useRef, useState } from "react";
import type { ExportFormat } from "@/lib/editor/draft";
export type DialogKind = "export" | "help" | null;
interface Props {
  kind: DialogKind;
  onClose: () => void;
  onExport: (format: ExportFormat, includeTitlePage: boolean) => void;
  onPrint: (includeTitlePage: boolean) => void;
  /** Where drafts are kept, when it is not this browser (the desktop app). */
  storageNote?: string;
}
export function EditorDialog({
  kind,
  onClose,
  onExport,
  onPrint,
  storageNote,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Off every time the dialog opens.
  const [titlePage, setTitlePage] = useState(false);
  useEffect(() => {
    if (kind) ref.current?.showModal();
    else ref.current?.close();
    setTitlePage(false);
  }, [kind]);
  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <button className="close" aria-label="Close dialog" onClick={onClose}>
        ×
      </button>
      {kind === "export" ? (
        <>
          <div className="eyebrow">TAKE YOUR STORY WITH YOU</div>
          <h2 id="dialog-title">Export screenplay</h2>
          <p>Create a copy of your current working draft.</p>
          <label className="export-title-page">
            <input
              type="checkbox"
              checked={titlePage}
              onChange={(event) => setTitlePage(event.target.checked)}
            />
            Include title page
          </label>
          <button className="export-option" onClick={() => onPrint(titlePage)}>
            Print / Save as PDF ↗
            <small>
              Formatted US Letter pages. Select 100% scale and turn off browser
              headers.
            </small>
          </button>
          <button
            className="export-option"
            onClick={() => onExport("fdx", titlePage)}
          >
            Final Draft (.fdx) ↓
            <small>Editable screenplay with element types.</small>
          </button>
          <button
            className="export-option"
            onClick={() => onExport("fountain", titlePage)}
          >
            Fountain file ↓
            <small>Plain-text screenplay for other writing apps.</small>
          </button>
          <button
            className="export-option"
            onClick={() => onExport("json", titlePage)}
          >
            Draft backup ↓
            <small>
              JSON with scene and element identities. Always includes the title
              page.
            </small>
          </button>
        </>
      ) : (
        <>
          <div className="eyebrow">MAKE YOURSELF AT HOME</div>
          <h2 id="dialog-title">Just keep writing.</h2>
          <p>
            {storageNote ??
              "Your draft saves in this browser. Export a copy whenever you need one."}
          </p>
          <div className="shortcut-row">
            <span>Next element</span>
            <kbd>Enter</kbd>
          </div>
          <div className="shortcut-row">
            <span>Line break</span>
            <kbd>Shift + Enter</kbd>
          </div>
          <div className="shortcut-row">
            <span>Change element type</span>
            <kbd>Tab / Shift + Tab</kbd>
          </div>
          <div className="shortcut-row">
            <span>Save locally</span>
            <kbd>⌘ / Ctrl + S</kbd>
          </div>
          <p>
            Letter paper · 12 pt Courier · 6 lines per inch.
            <br />
            Margins: 1.5″ left; 1″ top, right, and bottom.
          </p>
        </>
      )}
    </dialog>
  );
}
