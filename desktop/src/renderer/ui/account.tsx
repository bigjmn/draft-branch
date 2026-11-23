/** Sign in to DraftBranch from the desktop app. Email and password sign in
 * right here; Google signs in through the person's own browser, because Google
 * does not allow its sign-in inside an app window (see main/google-auth.ts). */
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithCredential,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { authErrorMessage } from "@/lib/firebase/auth-errors";
import { firebaseAuth } from "@/lib/firebase/client";
import { device } from "../platform/bridge";
import { cloudConfigured, useOnline } from "../platform/online";
import { LegalDialog } from "./legal";

type Mode = "signin" | "signup";
const MIN_PASSWORD = 8;

/** The shared messages, plus the one failure only a desktop build can hit. */
function signInError(error: unknown): string | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code.includes("referer"))
    return "DraftBranch cloud isn’t accepting sign-ins from the desktop app yet. See “Sign-in is blocked” in desktop/README.md.";
  return authErrorMessage(error);
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { user } = useAuth();
  const online = useOnline();
  const [mode, setMode] = useState<Mode>("signin");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<"" | "email" | "google">("");
  const [error, setError] = useState<string | null>(null);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const signedIn = !!user && !user.isAnonymous;

  useEffect(() => {
    dialog.current?.showModal();
    // Leaving the dialog abandons a Google sign-in still waiting in the browser.
    return () => void device({ kind: "auth.cancel" }).catch(() => {});
  }, []);
  useEffect(() => {
    if (signedIn) onClose();
  }, [signedIn, onClose]);

  async function run(kind: "email" | "google", action: () => Promise<unknown>) {
    if (busy) return;
    if (mode === "signup" && !agreed) {
      setError(
        "Please agree to the Terms of Use and Privacy Policy to continue.",
      );
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(signInError(caught));
    }
    setBusy("");
  }
  const google = () =>
    run("google", async () => {
      const tokens = await device({ kind: "auth.google" });
      if (!tokens) return; // Cancelled, or the browser tab was left open too long.
      await signInWithCredential(
        firebaseAuth(),
        GoogleAuthProvider.credential(tokens.idToken, tokens.accessToken),
      );
    });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (mode === "signup" && password !== String(form.get("confirm") ?? "")) {
      setError("Passwords don’t match. Please try again.");
      return;
    }
    void run("email", () =>
      mode === "signup"
        ? createUserWithEmailAndPassword(firebaseAuth(), email, password)
        : signInWithEmailAndPassword(firebaseAuth(), email, password),
    );
  }
  const blocked = !!busy || !online || !cloudConfigured;

  return (
    <dialog
      ref={dialog}
      className="account-dialog"
      aria-labelledby="account-title"
      onCancel={(event) => {
        event.preventDefault();
        if (busy !== "email") onClose();
      }}
    >
      <button className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="account-tabs">
        {(["signin", "signup"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
          >
            {value === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>
      <h2 id="account-title">
        {mode === "signin"
          ? "Sign in to DraftBranch"
          : "Create your DraftBranch account"}
      </h2>
      <p>
        Pull your cloud projects onto this computer, keep working offline, and
        publish your revisions when you’re back online. Projects made on this
        device stay here either way.
      </p>
      {!cloudConfigured ? (
        <p className="vc-warning" role="alert">
          This build was made without a Firebase API key, so it can’t reach
          DraftBranch cloud. See desktop/README.md, then rebuild.
        </p>
      ) : (
        !online && (
          <p className="vc-warning" role="alert">
            You’re offline. Signing in needs a connection.
          </p>
        )
      )}
      {mode === "signup" && (
        <label className="account-agreement">
          <input
            type="checkbox"
            checked={agreed}
            disabled={!!busy}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          <span>
            I agree to the{" "}
            <button
              type="button"
              className="vc-link"
              onClick={() => setLegal("terms")}
            >
              Terms of Use
            </button>{" "}
            and{" "}
            <button
              type="button"
              className="vc-link"
              onClick={() => setLegal("privacy")}
            >
              Privacy Policy
            </button>
          </span>
        </label>
      )}
      <button
        type="button"
        className="account-google"
        disabled={blocked || (mode === "signup" && !agreed)}
        onClick={() => void google()}
      >
        {busy === "google"
          ? "Waiting for your browser…"
          : "Continue with Google"}
      </button>
      {busy === "google" && (
        <p className="account-note" role="status">
          Finish signing in in the browser window that just opened, then come
          back here.{" "}
          <button
            type="button"
            className="vc-link"
            onClick={() => void device({ kind: "auth.cancel" })}
          >
            Cancel
          </button>
        </p>
      )}
      <div className="account-divider">
        <span>or with email</span>
      </div>
      <form className="account-form" onSubmit={submit}>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={blocked}
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
            disabled={blocked}
          />
        </label>
        {mode === "signup" && (
          <label>
            Confirm password
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              disabled={blocked}
            />
          </label>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <button
          className="primary-action"
          disabled={blocked || (mode === "signup" && !agreed)}
        >
          {busy === "email"
            ? "One moment…"
            : mode === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      {legal && <LegalDialog document={legal} onClose={() => setLegal(null)} />}
    </dialog>
  );
}
