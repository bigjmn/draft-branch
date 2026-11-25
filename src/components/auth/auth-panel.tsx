"use client";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { useState, type FormEvent } from "react";
import { authErrorMessage } from "@/lib/firebase/auth-errors";
import { firebaseAuth } from "@/lib/firebase/client";
import { requestPasswordReset, signInUrl } from "@/lib/firebase/password-reset";
import { useAuth } from "./auth-provider";

export type AuthMode = "signup" | "signin";
type Mode = AuthMode;
const MIN_PASSWORD = 8;

/** Sign-up / sign-in form. The page that renders it redirects once `useAuth().user` is set.
 * Pass `mode` and `onModeChange` to control the tab from outside; otherwise it manages itself.
 */
export function AuthPanel({
  mode: controlledMode,
  onModeChange,
}: {
  mode?: AuthMode;
  onModeChange?: (mode: AuthMode) => void;
}) {
  const { user } = useAuth();
  const [ownMode, setOwnMode] = useState<Mode>("signup");
  const mode = controlledMode ?? ownMode;
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The email typed so far, carried into the password-reset form.
  const [email, setEmail] = useState("");
  const [resetting, setResetting] = useState(false);

  async function run(action: () => Promise<unknown>) {
    if (mode === "signup" && !agreed) {
      setError(
        "Please agree to the Terms of Use and Privacy Policy to continue.",
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(authErrorMessage(caught));
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (
      mode === "signup" &&
      password !== String(form.get("confirmPassword") ?? "")
    ) {
      setPasswordMismatch(true);
      const confirmation =
        event.currentTarget.elements.namedItem("confirmPassword");
      if (confirmation instanceof HTMLInputElement) confirmation.focus();
      return;
    }
    setPasswordMismatch(false);
    run(() =>
      mode === "signup"
        ? createUserWithEmailAndPassword(firebaseAuth(), email, password)
        : signInWithEmailAndPassword(firebaseAuth(), email, password),
    );
  }

  const switchMode = (next: Mode) => {
    setPasswordMismatch(false);
    setResetting(false);
    setOwnMode(next);
    onModeChange?.(next);
    setError(null);
  };
  // Not disabled while the saved session loads: that can take a moment, and
  // signing in again at that point is harmless. A guest may sign in to an account.
  const disabled = busy || Boolean(user && !user.isAnonymous);

  if (resetting)
    return (
      <PasswordReset
        email={email}
        disabled={Boolean(user && !user.isAnonymous)}
        onBack={(typed) => {
          setEmail(typed);
          setResetting(false);
          setError(null);
        }}
      />
    );

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-tabs">
        <button
          type="button"
          aria-pressed={mode === "signup"}
          onClick={() => switchMode("signup")}
        >
          Create account
        </button>
        <button
          type="button"
          aria-pressed={mode === "signin"}
          onClick={() => switchMode("signin")}
        >
          Sign in
        </button>
      </div>
      <h2 id="auth-title">
        {mode === "signup" ? "Start your first draft" : "Welcome back"}
      </h2>
      <p className="auth-lede">
        {mode === "signup"
          ? "Create a free account to open your writing room."
          : "Sign in to pick up where you left off."}
      </p>

      {mode === "signup" && (
        <div className="auth-agreement">
          <input
            id="legal-agreement"
            type="checkbox"
            checked={agreed}
            disabled={disabled}
            onChange={(event) => setAgreed(event.target.checked)}
            aria-labelledby="legal-agreement-label"
          />
          <label id="legal-agreement-label" htmlFor="legal-agreement">
            I agree to the{" "}
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              Terms of Use
            </a>{" "}
            and{" "}
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
          </label>
        </div>
      )}

      <button
        type="button"
        className="google-button"
        disabled={disabled || (mode === "signup" && !agreed)}
        onClick={() =>
          run(() => signInWithPopup(firebaseAuth(), new GoogleAuthProvider()))
        }
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="auth-divider">
        <span>or with email</span>
      </div>

      <form
        className="auth-form"
        onSubmit={onSubmit}
        onInput={() => setPasswordMismatch(false)}
      >
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={disabled}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span className="auth-label-row">
            Password
            {mode === "signin" && (
              <button
                type="button"
                className="auth-forgot"
                disabled={disabled}
                onClick={() => {
                  setResetting(true);
                  setError(null);
                }}
              >
                Forgot password?
              </button>
            )}
          </span>
          <input
            name="password"
            type="password"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            minLength={mode === "signup" ? MIN_PASSWORD : undefined}
            required
            disabled={disabled}
          />
          {mode === "signup" && (
            // <small>At least {MIN_PASSWORD} characters.</small>
            <small>Same one you use for everything.</small>
          )}
        </label>
        {mode === "signup" && (
          <label>
            Confirm password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              disabled={disabled}
              aria-invalid={passwordMismatch || undefined}
              aria-describedby={
                passwordMismatch ? "password-match-error" : undefined
              }
            />
            <small>Run it back now, y'all.</small>
            {passwordMismatch && (
              <span
                id="password-match-error"
                className="auth-error"
                role="alert"
              >
                Passwords don’t match. Please try again.
              </span>
            )}
          </label>
        )}
        <p className="auth-error" role="alert">
          {error}
        </p>
        <button
          type="submit"
          className="auth-submit"
          disabled={disabled || (mode === "signup" && !agreed)}
        >
          {busy
            ? "One moment…"
            : mode === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
    </section>
  );
}

/** "Forgot password?": ask for the email, send the link, then say to check
 * the inbox — the same message whether or not an account exists. */
function PasswordReset({
  email: initialEmail,
  disabled,
  onBack,
}: {
  email: string;
  disabled: boolean;
  onBack: (email: string) => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    setBusy(true);
    setError(null);
    try {
      await requestPasswordReset(
        firebaseAuth(),
        address,
        signInUrl(window.location.origin),
      );
      setSentTo(address);
    } catch (caught) {
      setError(authErrorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <h2 id="auth-title">
        {sentTo ? "Check your email" : "Reset your password"}
      </h2>
      {sentTo ? (
        <div className="auth-reset-sent" role="status">
          <p className="auth-lede">
            If there’s a DraftBranch account for <strong>{sentTo}</strong>,
            we’ve sent it a link to choose a new password.
          </p>
          <p className="auth-lede">
            Don’t see it in a few minutes? Check your spam folder, or{" "}
            <button
              type="button"
              className="auth-inline-link"
              onClick={() => setSentTo(null)}
            >
              send it again
            </button>
            .
          </p>
        </div>
      ) : (
        <>
          <p className="auth-lede">
            Enter the email you signed up with and we’ll send you a link to
            choose a new password.
          </p>
          <form className="auth-form" onSubmit={onSubmit}>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                disabled={disabled || busy}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <p className="auth-error" role="alert">
              {error}
            </p>
            <button
              type="submit"
              className="auth-submit"
              disabled={disabled || busy}
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        </>
      )}
      <button
        type="button"
        className="auth-back"
        onClick={() => onBack(sentTo ?? email)}
      >
        ← Back to sign in
      </button>
    </section>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
