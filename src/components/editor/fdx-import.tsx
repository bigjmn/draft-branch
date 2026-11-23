"use client";
import { useRef, useState } from "react";
import { readFdx } from "@/lib/editor/import";
import { readPdf } from "@/lib/editor/pdf-import";
import type { Draft } from "@/lib/editor/types";
export function FdxFileInput({
  onChange,
  disabled = false,
}: {
  onChange: (draft: Draft | null) => void;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  return (
    <div className="fdx-import">
      <label>
        Import screenplay (.fdx or .pdf)
        <input
          type="file"
          accept=".fdx,.pdf,application/pdf"
          disabled={disabled}
          onChange={async (e) => {
            const input = e.currentTarget;
            input.setCustomValidity(
              input.files?.length
                ? "Wait for the screenplay file to finish loading."
                : "",
            );
            const ticket = ++sequence.current;
            const file = e.target.files?.[0];
            onChange(null);
            setMessage("");
            if (!file) return;
            try {
              setMessage("Reading screenplay…");
              const result = await (/\.pdf$/i.test(file.name)
                ? readPdf(file)
                : readFdx(file));
              if (ticket !== sequence.current) return;
              input.setCustomValidity("");
              onChange(result.draft);
              setMessage(
                `${result.draft.blocks.length} elements ready. ${result.warnings.join(" ")}`,
              );
            } catch (error) {
              if (ticket === sequence.current) {
                input.setCustomValidity(
                  "Choose a valid FDX or PDF file or clear the file selection.",
                );
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Could not read this file.",
                );
              }
            }
          }}
        />
      </label>
      <p role="status">{message}</p>
    </div>
  );
}
export function FdxImportButton({
  onImport,
}: {
  onImport: (draft: Draft) => void;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  return (
    <>
      <button className="button" onClick={() => modal.current?.showModal()}>
        Import FDX / PDF
      </button>
      <dialog ref={modal} className="create-project-dialog">
        <h2>Import screenplay</h2>
        <p>
          This replaces the current working draft. Export a copy first if you
          want to keep it. Committed revisions remain in version control.
        </p>
        <FdxFileInput onChange={setDraft} />
        <div className="dialog-actions">
          <button onClick={() => modal.current?.close()}>Cancel</button>
          <button
            disabled={!draft}
            onClick={() => {
              if (draft) onImport(draft);
              modal.current?.close();
            }}
          >
            Replace draft
          </button>
        </div>
      </dialog>
    </>
  );
}
