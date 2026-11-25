import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { InvitationMessage } from "./projects/mail";

/** Where messages from the landing page's contact form go. */
export const CONTACT_TO = "jesse.a.nicholas@gmail.com";

export interface ContactForm {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export const CONTACT_LIMITS = {
  name: 100,
  email: 254,
  subject: 150,
  message: 5000,
  perSenderPerHour: 3,
  perDay: 50,
};

const EMAIL =
  /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/** Validate the form, or return null for a bot that filled the hidden field. */
export function parseContact(data: unknown): ContactForm | null {
  const input = (data ?? {}) as Record<string, unknown>;
  if (typeof input.website === "string" && input.website.trim()) return null;
  const text = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string).trim() : "";
  const form = {
    name: text("name").replace(/\s*[\r\n]+\s*/g, " "),
    email: text("email"),
    subject: text("subject").replace(/\s*[\r\n]+\s*/g, " "),
    message: text("message").replace(/\r\n?/g, "\n"),
  };
  if (!form.name || form.name.length > CONTACT_LIMITS.name)
    throw new HttpsError(
      "invalid-argument",
      "Enter your name (up to 100 characters).",
    );
  if (form.email.length > CONTACT_LIMITS.email || !EMAIL.test(form.email))
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  if (!form.subject || form.subject.length > CONTACT_LIMITS.subject)
    throw new HttpsError(
      "invalid-argument",
      "Enter a subject (up to 150 characters).",
    );
  if (!form.message || form.message.length > CONTACT_LIMITS.message)
    throw new HttpsError(
      "invalid-argument",
      "Enter a message (up to 5,000 characters).",
    );
  return form;
}

export function contactMessage(
  form: ContactForm,
): InvitationMessage & { replyTo: string } {
  return {
    to: CONTACT_TO,
    replyTo: `${form.name.replace(/["\\]/g, "")} <${form.email}>`,
    subject: `DraftBranch contact: ${form.subject}`,
    messageId: `<draftbranch-contact-${randomUUID()}@draftbranch.com>`,
    text: `${form.message}\n\n—\nFrom: ${form.name} <${form.email}>\nSent from the contact form on draftbranch.com. Reply to this email to answer them directly.`,
  };
}

/**
 * Count a send against two limits: a few per sender per hour (the sender is
 * the hashed IP address, so the address itself is never stored) and an overall
 * daily cap, so a flood can't run up the mail quota.
 */
export async function claimContactQuota(
  db: Firestore,
  sender: string,
  now = Date.now(),
) {
  const hour = 60 * 60 * 1000,
    day = 24 * hour;
  const senderRef = db.doc(
    `contactLimits/${createHash("sha256").update(sender).digest("hex").slice(0, 32)}`,
  );
  const dayRef = db.doc(
    `contactLimits/day-${new Date(now).toISOString().slice(0, 10)}`,
  );
  await db.runTransaction(async (tx) => {
    const [mine, today] = await tx.getAll(senderRef, dayRef);
    const recent = ((mine.data()?.sent as number[] | undefined) ?? []).filter(
      (time) => time > now - hour,
    );
    if (recent.length >= CONTACT_LIMITS.perSenderPerHour)
      throw new HttpsError(
        "resource-exhausted",
        "You’ve sent a few messages already. Please try again in an hour, or email directly.",
      );
    if ((today.data()?.count ?? 0) >= CONTACT_LIMITS.perDay)
      throw new HttpsError(
        "resource-exhausted",
        "The contact form is busy right now. Please email directly instead.",
      );
    tx.set(senderRef, {
      sent: [...recent, now],
      expiresAt: new Date(now + hour),
    });
    tx.set(
      dayRef,
      { count: FieldValue.increment(1), expiresAt: new Date(now + 2 * day) },
      { merge: true },
    );
  });
}
