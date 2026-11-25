import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";

interface MailJob {
  projectId: string;
  invitationId: string;
  to: string;
  ownerName: string;
  title: string;
  role: string;
  /** An editor's dedicated branch, if the owner made one. */
  branch?: string | null;
  /** The owner's optional personal note. */
  note?: string;
  /** Only the invited person, signed in, may read the project. */
  requireSignIn?: boolean;
  link: string;
  attempts: number;
}
export interface InvitationMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}
/** The opening line: who invited you, to what, and how you can take part. */
export function invitationSummary(job: {
  ownerName: string;
  title: string;
  role: string;
  branch?: string | null;
}): string {
  if (job.role === "editor" && job.branch)
    return `${job.ownerName} invited you to edit “${job.title}” with dedicated branch “${job.branch}”.`;
  if (job.role === "editor")
    return `${job.ownerName} invited you to edit “${job.title}”.`;
  if (job.role === "commenter")
    return `${job.ownerName} invited you to comment on “${job.title}”.`;
  return `${job.ownerName} invited you to read “${job.title}”.`;
}
export function invitationMessage(
  job: MailJob,
  jobId: string,
): InvitationMessage {
  const next = job.requireSignIn
    ? job.role === "editor" && job.branch
      ? `Sign in or create an account with this email address, verify it, and accept the invitation. The branch “${job.branch}” is made for you then, and you write there. You can still read every other branch.`
      : job.role === "editor"
        ? "Sign in or create an account with this email address, verify it, and accept the invitation to branch and contribute."
        : job.role === "commenter"
          ? "Sign in or create an account with this email address, verify it, and accept the invitation to comment on the pages."
          : "Sign in or create an account with this email address, verify it, and accept the invitation to read the project."
    : job.role === "editor"
      ? job.branch
        ? `Sign in or create an account with this email address, verify it, and accept the invitation. The branch “${job.branch}” is made for you then, and you write there. You can still read every other branch. You can also continue with read-only access without an account.`
        : "Sign in or create an account with this email address, verify it, and accept the invitation to branch and contribute. You can also continue with read-only access without an account."
      : job.role === "commenter"
        ? "Sign in or create an account with this email address, verify it, and accept the invitation to comment on the pages. You can also read without an account."
        : "You can read without creating an account, or sign in to add the project to your dashboard.";
  const linkNotice = job.requireSignIn
    ? "This link expires after 7 days. The project opens only for you, signed in with this email address."
    : "This link expires after 7 days. Anyone holding it can read the committed branches and revision history until it expires or is revoked. Keep it private.";
  const note = job.note?.trim()
    ? `\n\nA note from ${job.ownerName}:\n${job.note
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    : "";
  return {
    to: job.to,
    subject: `${job.ownerName} invited you to “${job.title}” on DraftBranch`
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200),
    messageId: `<draftbranch-invitation-${jobId}@draftbranch.com>`,
    text: `${invitationSummary(job)}${note}\n\n${next}\n\nOpen your invitation:\n${job.link}\n\n${linkNotice}\n\nIf you weren’t expecting this invitation, you can ignore it.\nDraftBranch · J Nicks Productions`,
  };
}

/** A transaction lease prevents concurrent sends. SMTP cannot promise exactly-once delivery. */
export async function deliverInvitation(
  db: Firestore,
  jobId: string,
  send: (message: InvitationMessage) => Promise<void>,
) {
  const ref = db.doc(`invitationMail/${jobId}`),
    lease = randomUUID();
  const job = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data()!;
    if (["sent", "failed", "cancelled"].includes(data.status)) return null;
    if (data.leaseUntil > Date.now())
      throw new Error("Invitation delivery lease is busy.");
    const inviteRef = db.doc(
      `projects/${data.projectId}/invitations/${data.invitationId}`,
    );
    const project = await tx.get(db.doc(`projects/${data.projectId}`));
    const invite = await tx.get(inviteRef);
    const invitation = invite.data();
    const inviter = invitation
      ? await tx.get(
          db.doc(`projects/${data.projectId}/members/${invitation.invitedBy}`),
        )
      : null;
    if (
      !project.exists ||
      project.data()?.deleting ||
      !invitation ||
      invitation.status !== "pending" ||
      invitation.expiresAt.toMillis() <= Date.now() ||
      inviter?.data()?.role !== "owner"
    ) {
      tx.update(ref, {
        status: "cancelled",
        link: FieldValue.delete(),
        to: FieldValue.delete(),
      });
      if (invite.exists) tx.update(inviteRef, { deliveryStatus: "cancelled" });
      return null;
    }
    if (data.attempts >= 5) {
      tx.update(ref, {
        status: "failed",
        link: FieldValue.delete(),
        to: FieldValue.delete(),
      });
      tx.update(inviteRef, { deliveryStatus: "failed" });
      return null;
    }
    tx.update(ref, {
      status: "sending",
      lease,
      leaseUntil: Date.now() + 180000,
      attempts: data.attempts + 1,
    });
    return data as MailJob;
  });
  if (!job) return;
  try {
    await send(invitationMessage(job, jobId));
  } catch {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.lease !== lease) return;
      const terminal = snapshot.data()!.attempts >= 5;
      tx.update(ref, {
        status: terminal ? "failed" : "queued",
        leaseUntil: 0,
        ...(terminal
          ? { link: FieldValue.delete(), to: FieldValue.delete() }
          : {}),
      });
      tx.update(
        db.doc(`projects/${job.projectId}/invitations/${job.invitationId}`),
        { deliveryStatus: terminal ? "failed" : "retrying" },
      );
    });
    // Never log provider errors: they can include SMTP credentials or invitation URLs.
    throw new Error("Invitation email delivery failed.");
  }
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.data()?.lease !== lease) return;
    tx.update(ref, {
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
      link: FieldValue.delete(),
      to: FieldValue.delete(),
      leaseUntil: 0,
    });
    tx.update(
      db.doc(`projects/${job.projectId}/invitations/${job.invitationId}`),
      { deliveryStatus: "sent" },
    );
  });
}

export async function smtpSend(
  smtpUrl: string,
  from: string,
  message: InvitationMessage & { replyTo?: string },
) {
  if (!smtpUrl || !from || /[\r\n]/.test(from))
    throw new Error("Invitation mail is not configured.");
  const url = new URL(smtpUrl);
  if (!["smtp:", "smtps:"].includes(url.protocol))
    throw new Error("Invalid SMTP transport.");
  const transport = nodemailer.createTransport(
    {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)),
      secure: url.protocol === "smtps:",
      auth: url.username
        ? {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          }
        : undefined,
      requireTLS: true,
      connectionTimeout: 15000,
      socketTimeout: 30000,
      disableFileAccess: true,
      disableUrlAccess: true,
    },
    { from },
  );
  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}
