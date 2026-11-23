"use client";
import { useRef, useState } from "react";
import { firebaseAuth } from "@/lib/firebase/client";
import { deleteProject } from "@/lib/projects/client";
export function DeleteProject({
  projectId,
  title,
}: {
  projectId: string;
  title: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="delete-project-trigger"
        aria-label={`Delete ${title}`}
        onClick={() => {
          setConfirmation("");
          setError("");
          dialog.current?.showModal();
        }}
      >
        Delete project
      </button>
      <dialog
        className="create-project-dialog"
        ref={dialog}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || confirmation !== title) return;
            setBusy(true);
            setError("");
            try {
              await deleteProject(projectId, confirmation);
              try {
                const uid = firebaseAuth().currentUser?.uid;
                if (uid)
                  for (const key of Object.keys(localStorage)) {
                    if (
                      key.startsWith(
                        `draftbranch.project.v1.${uid}.${projectId}.`,
                      ) ||
                      key.startsWith(
                        `scriptroom.project.v1.${uid}.${projectId}.`,
                      )
                    )
                      localStorage.removeItem(key);
                  }
              } catch {
                /* Remote deletion has succeeded even if local storage is unavailable. */
              }
              dialog.current?.close();
            } catch {
              setError(
                "Couldn’t confirm deletion. Please retry. Only the project owner can delete it.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Delete project?</h2>
          <p>
            This permanently deletes <strong>{title}</strong>, including its
            scripts, branches, revision history, comments, and invitations.
            Collaborators will lose access. Export anything you want to keep
            first.
          </p>
          <label>
            Type “{title}” to confirm
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button
              className="danger-action"
              disabled={busy || confirmation !== title}
            >
              {busy ? "Deleting…" : "Permanently delete project"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
