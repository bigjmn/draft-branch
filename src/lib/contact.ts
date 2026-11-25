import { httpsCallable } from "firebase/functions";
import { firebaseFunctions } from "@/lib/firebase/client";

/** Shown on the landing page and used when the form can't send. */
export const CONTACT_EMAIL = "jesse.a.nicholas@gmail.com";

export interface ContactInput {
  name: string;
  email: string;
  subject: string;
  message: string;
  /** Hidden from people; anything typed here marks the sender as a bot. */
  website: string;
}

export async function sendContactMessage(input: ContactInput): Promise<void> {
  await httpsCallable<ContactInput, { status: string }>(
    firebaseFunctions(),
    "sendContactMessage",
  )(input);
}

/** A readable reason from a failed callable, falling back to a generic one.
 * The Firebase SDK appends the HTTP status (" [429]"), which is dropped. */
export function contactErrorMessage(error: unknown): string {
  const { code, message } = (error ?? {}) as {
    code?: string;
    message?: string;
  };
  if (
    message &&
    ["functions/invalid-argument", "functions/resource-exhausted"].includes(
      code ?? "",
    )
  )
    return message
      .replace(/\s*\[\d+\]$/, "")
      .replace(/email directly/, `email ${CONTACT_EMAIL}`);
  return `Your message couldn’t be sent. Please try again, or email ${CONTACT_EMAIL}.`;
}
