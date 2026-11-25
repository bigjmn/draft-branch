import { sendPasswordResetEmail, type Auth } from "firebase/auth";

/**
 * Email a password-reset link. Firebase hosts the page that sets the new
 * password; `continueUrl` (an authorized domain) adds a button on that page
 * that brings the person back to sign in.
 *
 * Whether an account exists is never revealed: "no such user" counts as sent,
 * and the caller always shows the same "check your email" message.
 */
export async function requestPasswordReset(
  auth: Auth,
  email: string,
  continueUrl?: string,
): Promise<void> {
  const send = (url?: string) =>
    sendPasswordResetEmail(
      auth,
      email,
      url ? { url, handleCodeInApp: false } : undefined,
    );
  try {
    await send(continueUrl);
  } catch (error) {
    const code = errorCode(error);
    if (code === "auth/user-not-found") return;
    // A host missing from Authorized domains still deserves a working reset:
    // send it without the "continue" button rather than failing.
    if (
      continueUrl &&
      [
        "auth/unauthorized-continue-uri",
        "auth/invalid-continue-uri",
        "auth/missing-continue-uri",
      ].includes(code)
    ) {
      try {
        await send();
      } catch (retry) {
        if (errorCode(retry) !== "auth/user-not-found") throw retry;
      }
      return;
    }
    throw error;
  }
}

/** Where the reset page's "Continue" button leads on the website. */
export function signInUrl(origin: string): string | undefined {
  return /^https?:\/\//.test(origin) ? `${origin}/?signin#account` : undefined;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}
