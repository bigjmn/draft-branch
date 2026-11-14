"use client";
import { useEffect, useRef } from "react";
export type DialogKind = "export" | "help" | null;
interface Props {
  kind: DialogKind;
  onClose: () => void;
  onExport: (format: "fountain" | "json") => void;
  onPrint: () => void;
}
export function EditorDialog({ kind, onClose, onExport, onPrint }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (kind) ref.current?.showModal();
    else ref.current?.close();
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
          <button className="export-option" onClick={onPrint}>
            Print / Save as PDF ↗
            <small>
              Formatted US Letter pages. Select 100% scale and turn off browser
              headers.
            </small>
          </button>
          <button
            className="export-option"
            onClick={() => onExport("fountain")}
          >
            Fountain file ↓
            <small>Plain-text screenplay for other writing apps.</small>
          </button>
          <button className="export-option" onClick={() => onExport("json")}>
            Draft backup ↓<small>JSON with scene and element identities.</small>
          </button>
        </>
      ) : (
        <>
          <div className="eyebrow">MAKE YOURSELF AT HOME</div>
          <h2 id="dialog-title">Just keep writing.</h2>
          <p>
            Your draft saves in this browser. Export a copy whenever you need
            one.
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
