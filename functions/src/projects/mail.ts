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
  link: string;
  attempts: number;
}
export interface InvitationMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}
export function invitationMessage(
  job: MailJob,
  jobId: string,
): InvitationMessage {
  const role = job.role === "editor" ? "Editor" : "Reader";
  return {
    to: job.to,
    subject: "You’re invited to a DraftBranch project",
    messageId: `<draftbranch-invitation-${jobId}@draftbranch.com>`,
    text: `${job.ownerName} has invited you to “${job.title}” with ${role} access.\n\n${role === "Editor" ? "Sign in or create an account with this email address, verify it, and accept the invitation to branch and contribute. You can also continue with read-only access without an account." : "You can read without creating an account, or sign in to add the project to your dashboard."}\n\nOpen your invitation:\n${job.link}\n\nThis link expires after 7 days. Anyone holding it can read the latest committed main draft until it expires or is revoked. Keep it private.\n\nIf you weren’t expecting this invitation, you can ignore it.\nDraftBranch · J Nicks Productions`,
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
    const invite = await tx.get(inviteRef);
    const invitation = invite.data();
    const inviter = invitation
      ? await tx.get(
          db.doc(`projects/${data.projectId}/members/${invitation.invitedBy}`),
        )
      : null;
    if (
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
  message: InvitationMessage,
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
