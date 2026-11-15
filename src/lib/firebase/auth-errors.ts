/** Maps Firebase Auth error codes to writer-facing messages.
 * Returns null when the user cancelled and no message should be shown.
 */
export function authErrorMessage(error: unknown): string | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return null;
    case "auth/email-already-in-use":
      return "An account already exists for this email. Sign in instead.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/weak-password":
      return "Choose a longer password.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "That email and password don't match an account.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment, then try again.";
    case "auth/network-request-failed":
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.";
    case "auth/unauthorized-domain":
      return "Sign-in isn't enabled for this web address yet.";
    case "auth/operation-not-allowed":
      return "This sign-in method isn't available right now.";
    default:
      return "Something went wrong. Please try again.";
  }
}
