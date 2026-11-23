/** "Continue with Google" for the desktop app, run in the person's own browser.
 *
 * The app serves this page on http://localhost while a sign-in is in progress
 * (see src/main/google-auth.ts). It runs the same Google sign-in the web app
 * uses, hands the resulting Google credential straight back to the app over
 * that loopback connection, and keeps nothing: the session lives in memory
 * only and is dropped as soon as the credential has been delivered. */
import {
  GoogleAuthProvider,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { authErrorMessage } from "@/lib/firebase/auth-errors";
import { firebaseAuth } from "@/lib/firebase/client";
import "./auth.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "";
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const title = element("title");
const message = element("message");
const error = element("error");
const button = element<HTMLButtonElement>("continue");

function show(heading: string, text: string) {
  title.textContent = heading;
  message.textContent = text;
}
function finished(heading: string, text: string) {
  show(heading, text);
  button.hidden = true;
  error.textContent = "";
}

const auth = firebaseAuth();
// Nothing about this sign-in is written to the browser's storage.
const ready = setPersistence(auth, inMemoryPersistence).catch(() => {});

async function deliver(idToken: string, accessToken: string | undefined) {
  const response = await fetch("/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, idToken, accessToken }),
  });
  if (!response.ok) throw new Error("expired");
}

button.addEventListener("click", () => {
  button.disabled = true;
  error.textContent = "";
  // Opened directly from the click so the browser allows the Google window.
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  void signInWithPopup(auth, provider)
    .then(async (result) => {
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.idToken) throw new Error("no-credential");
      await ready;
      try {
        await deliver(credential.idToken, credential.accessToken);
      } catch {
        finished(
          "This sign-in link has expired",
          "Go back to DraftBranch and choose “Continue with Google” again.",
        );
        return;
      } finally {
        await signOut(auth).catch(() => {});
      }
      finished(
        "You’re signed in",
        "You can close this tab and go back to DraftBranch.",
      );
    })
    .catch((problem: unknown) => {
      button.disabled = false;
      error.textContent =
        problem instanceof Error && problem.message === "no-credential"
          ? "Google didn’t return a sign-in. Please try again."
          : (authErrorMessage(problem) ?? "");
    });
});

if (!/^[0-9a-f]{64}$/.test(state))
  finished(
    "Open this page from DraftBranch",
    "Choose “Continue with Google” in the DraftBranch desktop app to sign in.",
  );
