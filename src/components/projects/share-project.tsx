"use client";
import { useEffect, useRef, useState } from "react";
import {
  inviteProjectMember,
  removeProjectMember,
  revokeProjectInvitation,
  updateProjectMemberRole,
  watchSharing,
  type InvitationRole,
  type ProjectInvitation,
  type SharedMember,
} from "@/lib/projects/client";

export function ShareProject({
  projectId,
  uid,
}: {
  projectId: string;
  uid: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="version-trigger" onClick={() => setOpen(true)}>
        Share
      </button>
      {open && (
        <ShareDialog
          projectId={projectId}
          uid={uid}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function ShareDialog({
  projectId,
  uid,
  close,
}: {
  projectId: string;
  uid: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<SharedMember[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("reviewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return watchSharing(projectId, setMembers, setInvitations, () =>
      setError(
        "Sharing details are unavailable. Your access may have changed.",
      ),
    );
  }, [projectId]);
  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Sharing update failed. Please retry.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function invite() {
    const normalized = email.trim().toLowerCase();
    const signature = JSON.stringify([normalized, role]);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    await inviteProjectMember(projectId, normalized, role, request.current.id);
    request.current = null;
    setEmail("");
    setNotice("Invitation queued. Delivery status appears below.");
  }
  return (
    <dialog
      className="share-dialog"
      ref={dialog}
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="share-heading">
        <div>
          <p className="eyebrow">PRIVATE PROJECT</p>
          <h2 id="share-title">Share your screenplay</h2>
        </div>
        <button aria-label="Close sharing" disabled={busy} onClick={close}>
          ×
        </button>
      </div>
      <p className="share-description">
        Invite someone by email. Links share the committed branches and revision
        history; your uncommitted writing stays private.
      </p>
      <form
        className="share-invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(invite);
        }}
      >
        <label>
          Email address
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="writer@example.com"
          />
        </label>
        <label>
          Role
          <select
            value={role}
            disabled={busy}
            onChange={(e) => setRole(e.target.value as InvitationRole)}
          >
            <option value="reviewer">Reader</option>
            <option value="editor">Editor</option>
          </select>
        </label>
        <button className="primary-action" disabled={busy || !email.trim()}>
          {busy ? "Working…" : "Send invitation"}
        </button>
      </form>
      <p className="share-description">
        {role === "editor"
          ? "Editors can create branches and commit changes after signing in with their verified invited email. Only the owner can commit to main."
          : "Readers can view without an account. They cannot edit, branch, or commit."}
      </p>
      <p className="share-link-note">
        Anyone holding an invitation link can read it, including if it is
        forwarded. Links expire after 7 days and can be revoked below.
      </p>
      {error && (
        <p className="share-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <h3>People with accounts</h3>
      <ul className="share-list">
        {members.map((member) => (
          <li key={member.uid}>
            <div>
              <strong>
                {member.uid === uid
                  ? "You"
                  : member.displayName || member.email || "Writer"}
              </strong>
              {member.email && <small>{member.email}</small>}
            </div>
            {member.role === "owner" ? (
              <span>Owner</span>
            ) : (
              <>
                <select
                  aria-label={`Role for ${member.email || member.uid}`}
                  value={member.role}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() =>
                      updateProjectMemberRole(
                        projectId,
                        member.uid,
                        e.target.value as InvitationRole,
                      ),
                    )
                  }
                >
                  <option value="reviewer">Reader</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() => removeProjectMember(projectId, member.uid))
                  }
                >
                  Remove access
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <h3>Email invitations</h3>
      <p className="share-description">
        Revoking a link removes guest access and prevents acceptance. To remove
        an accepted member too, use Remove access above. Showing the latest 50
        invitations.
      </p>
      <ul className="share-list">
        {invitations.map((invite) => (
          <li key={invite.id}>
            <div>
              <strong>{invite.email}</strong>
              <small>
                {invite.role === "editor" ? "Editor" : "Reader"} ·{" "}
                {invite.status} · email {invite.deliveryStatus || "not queued"}
                {invite.expiresAt <= Date.now() ? " · link expired" : ""}
              </small>
            </div>
            {["pending", "accepted"].includes(invite.status) && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => revokeProjectInvitation(projectId, invite.id))
                }
              >
                Revoke link
              </button>
            )}
          </li>
        ))}
      </ul>
      {!invitations.length && (
        <p className="share-description">No invitations yet.</p>
      )}
    </dialog>
  );
}
