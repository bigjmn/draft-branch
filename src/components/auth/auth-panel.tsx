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
  const { user, loading } = useAuth();
  const [ownMode, setOwnMode] = useState<Mode>("signup");
  const mode = controlledMode ?? ownMode;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
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
    run(() =>
      mode === "signup"
        ? createUserWithEmailAndPassword(firebaseAuth(), email, password)
        : signInWithEmailAndPassword(firebaseAuth(), email, password),
    );
  }

  const switchMode = (next: Mode) => {
    setOwnMode(next);
    onModeChange?.(next);
    setError(null);
  };
  const disabled = busy || loading || Boolean(user);

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

      <button
        type="button"
        className="google-button"
        disabled={disabled}
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

      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={disabled}
          />
        </label>
        <label>
          Password
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
            <small>At least {MIN_PASSWORD} characters.</small>
          )}
        </label>
        <p className="auth-error" role="alert">
          {error}
        </p>
        <button type="submit" className="auth-submit" disabled={disabled}>
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
