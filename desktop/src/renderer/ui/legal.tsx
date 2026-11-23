/** Terms of Use and Privacy Policy, from the same Markdown files the web app
 * publishes (content/legal). Bundled, so they can be read offline. */
import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import privacy from "../../../../content/legal/privacy.md?raw";
import terms from "../../../../content/legal/terms.md?raw";

export function LegalDialog({
  document,
  onClose,
}: {
  document: "terms" | "privacy";
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      className="legal-dialog"
      aria-label={document === "terms" ? "Terms of Use" : "Privacy Policy"}
      onCancel={(event) => {
        // Close only this dialog, not the one it was opened from.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <button className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <article className="legal-content">
        <Markdown>{document === "terms" ? terms : privacy}</Markdown>
      </article>
    </dialog>
  );
}
