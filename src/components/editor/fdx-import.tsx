"use client";
import { useRef, useState } from "react";
import { readFdx } from "@/lib/editor/import";
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
        Import Final Draft (.fdx)
        <input
          type="file"
          accept=".fdx"
          disabled={disabled}
          onChange={async (e) => {
            const input = e.currentTarget;
            input.setCustomValidity(
              input.files?.length
                ? "Wait for the FDX file to finish loading."
                : "",
            );
            const ticket = ++sequence.current;
            const file = e.target.files?.[0];
            onChange(null);
            setMessage("");
            if (!file) return;
            try {
              const result = await readFdx(file);
              if (ticket !== sequence.current) return;
              input.setCustomValidity("");
              onChange(result.draft);
              setMessage(
                `${result.draft.blocks.length} elements ready. ${result.warnings.join(" ")}`,
              );
            } catch (error) {
              if (ticket === sequence.current) {
                input.setCustomValidity(
                  "Choose a valid FDX file or clear the file selection.",
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
        Import FDX
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
