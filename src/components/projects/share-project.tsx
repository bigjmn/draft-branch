"use client";
import { useEffect, useRef, useState } from "react";
import {
  ROLE_LABELS,
  describeAccess,
  type Role,
} from "@/lib/projects/permissions";
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
  // Editor options. A dedicated branch limits an editor to that branch (and
  // branches they make from it), so it rules out editing main.
  const [editMain, setEditMain] = useState(false);
  const [dedicated, setDedicated] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [commentMain, setCommentMain] = useState(true);
  const [note, setNote] = useState("");
  const [requireSignIn, setRequireSignIn] = useState(false);
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
  const editor = role === "editor";
  const branch = branchName.trim();
  const branchProblem = editor && dedicated ? branchNameProblem(branch) : null;
  async function invite() {
    const normalized = email.trim().toLowerCase();
    const options = {
      role,
      note: note.trim(),
      requireSignIn,
      ...(editor
        ? {
            editMain: dedicated ? false : editMain,
            commentMain,
            branch: dedicated ? branch : null,
          }
        : {}),
    };
    const signature = JSON.stringify([normalized, options]);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    await inviteProjectMember(
      projectId,
      normalized,
      options,
      request.current.id,
    );
    request.current = null;
    setEmail("");
    setNote("");
    setBranchName("");
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
          <h2 id="share-title">Share your project</h2>
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
            <option value="commenter">Commenter</option>
            <option value="editor">Editor</option>
          </select>
        </label>
        {editor && (
          <fieldset className="share-options">
            <legend>Editor access</legend>
            <label className="share-check">
              <input
                type="checkbox"
                checked={editMain && !dedicated}
                disabled={busy || dedicated}
                onChange={(e) => setEditMain(e.target.checked)}
              />
              <span>
                Allow to edit main branch
                <small>
                  {dedicated
                    ? "Not available with a dedicated branch: that editor writes only on their branch."
                    : "They can commit to main and merge other branches into it."}
                </small>
              </span>
            </label>
            <label className="share-check">
              <input
                type="checkbox"
                checked={dedicated}
                disabled={busy}
                onChange={(e) => setDedicated(e.target.checked)}
              />
              <span>
                Create dedicated branch
                <small>
                  Made for them when they join. They edit only that branch (and
                  branches they make from it), and can still read every other
                  branch.
                </small>
              </span>
            </label>
            <label className="share-branch-name">
              <span className="visually-hidden">Dedicated branch name</span>
              <span aria-hidden="true">⑂</span>
              <input
                value={branchName}
                disabled={busy || !dedicated}
                required={dedicated}
                maxLength={64}
                placeholder="branch-name"
                aria-invalid={dedicated && !!branch && !!branchProblem}
                aria-describedby="branch-name-hint"
                onChange={(e) =>
                  setBranchName(
                    e.target.value.toLowerCase().replace(/\s+/g, "-"),
                  )
                }
              />
            </label>
            {dedicated && (
              <small
                id="branch-name-hint"
                className={
                  branch && branchProblem
                    ? "share-hint share-hint-error"
                    : "share-hint"
                }
              >
                {branch && branchProblem
                  ? branchProblem
                  : "Lowercase letters, numbers and single hyphens, e.g. act-two-pass."}
              </small>
            )}
            <label className="share-check">
              <input
                type="checkbox"
                checked={commentMain}
                disabled={busy}
                onChange={(e) => setCommentMain(e.target.checked)}
              />
              <span>Allow comments on main branch</span>
            </label>
          </fieldset>
        )}
        <label className="share-check share-signin">
          <input
            type="checkbox"
            checked={requireSignIn}
            disabled={busy}
            onChange={(e) => setRequireSignIn(e.target.checked)}
          />
          <span>
            Require sign-in for read access
            <small>
              Only this email address, signed in, can open the project. The link
              alone won’t show the screenplay.
            </small>
          </span>
        </label>
        <label className="share-note">
          Note (optional)
          <textarea
            rows={3}
            maxLength={1000}
            value={note}
            disabled={busy}
            placeholder="Add a personal message to the invitation email"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          className="primary-action"
          disabled={busy || !email.trim() || !!branchProblem}
        >
          {busy ? "Working…" : "Send invitation"}
        </button>
      </form>
      <p className="share-description">{ROLE_HELP[role]}</p>
      <p className="share-link-note">
        {requireSignIn
          ? "This invitation opens only for the invited email address, signed in. Links expire after 7 days and can be revoked below."
          : "Anyone holding an invitation link can read it, including if it is forwarded. Links expire after 7 days and can be revoked below."}
      </p>
      {error && (
        <p className="share-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <details className="share-people">
        <summary>
          People and invitations
          <span>
            {members.length} {members.length === 1 ? "person" : "people"} ·{" "}
            {invitations.length}{" "}
            {invitations.length === 1 ? "invitation" : "invitations"}
          </span>
        </summary>
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
                {member.role === "editor" && (
                  <small>{describeAccess(member)}</small>
                )}
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
                    <option value="commenter">Commenter</option>
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
          Revoking a link removes guest access and prevents acceptance. To
          remove an accepted member too, use Remove access above. Showing the
          latest 50 invitations.
        </p>
        <ul className="share-list">
          {invitations.map((invite) => (
            <li key={invite.id}>
              <div>
                <strong>{invite.email}</strong>
                <small>
                  {invite.role === "editor"
                    ? describeAccess({ role: "editor", access: invite.access })
                    : ROLE_LABELS[invite.role as Role]}{" "}
                  {invite.requireSignIn ? "· sign-in required " : ""}·{" "}
                  {invite.status} · email{" "}
                  {invite.deliveryStatus || "not queued"}
                  {invite.expiresAt <= Date.now() ? " · link expired" : ""}
                </small>
              </div>
              {["pending", "accepted"].includes(invite.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      revokeProjectInvitation(projectId, invite.id),
                    )
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
      </details>
    </dialog>
  );
}

const ROLE_HELP: Record<InvitationRole, string> = {
  reviewer:
    "Readers can view every branch, even without an account. They can’t edit, branch, commit or comment.",
  commenter:
    "Commenters sign in with their verified invited email and comment on any branch. They can’t edit, branch or commit.",
  editor:
    "Editors sign in with their verified invited email to write, branch and commit, within the access you choose above.",
};

/** Why a dedicated branch name won't work, or null when it's fine. Mirrors
 * the server's rule for branch names. */
function branchNameProblem(name: string): string | null {
  if (!name) return "Enter a name for the dedicated branch.";
  if (name === "main") return "Choose a name other than main.";
  if (name.length > 64) return "Use 64 characters or fewer.";
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
    return "Start with a letter, and use lowercase letters, numbers and single hyphens.";
  return null;
}
