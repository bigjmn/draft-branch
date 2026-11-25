"use client";
import { onIdTokenChanged, type User } from "firebase/auth";
import { createContext, use, useEffect, useState } from "react";
import { firebaseAuth } from "@/lib/firebase/client";
import { debugLog, describeUser } from "@/lib/debug";

interface AuthState {
  user: User | null;
  /** True until Firebase has restored (or ruled out) a persisted session. */
  loading: boolean;
  revision: number;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  revision: 0,
});

/** How long to wait for Firebase before warning that sign-in state is stuck. */
const SLOW_AUTH_MS = 8000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    revision: 0,
  });
  useEffect(() => {
    let auth: ReturnType<typeof firebaseAuth>;
    try {
      auth = firebaseAuth();
    } catch (error) {
      // Without Auth nobody can be signed in. Say so rather than spin forever.
      console.error("[auth] Firebase Auth failed to start", error);
      setState((previous) => ({
        user: null,
        loading: false,
        revision: previous.revision + 1,
      }));
      return;
    }
    let active = true;
    let settled = false;
    debugLog("auth", "waiting for Firebase to restore the session");
    const publish = (source: string) => {
      if (!active) return;
      const first = !settled;
      settled = true;
      debugLog(
        "auth",
        `${first ? "session resolved" : "state changed"} (${source})`,
        describeUser(auth.currentUser),
      );
      setState((previous) => ({
        user: auth.currentUser,
        loading: false,
        revision: previous.revision + 1,
      }));
    };
    const unsubscribe = onIdTokenChanged(
      auth,
      () => publish("onIdTokenChanged"),
      (error) => console.error("[auth] onIdTokenChanged failed", error),
    );
    // Belt and braces: if the listener's first call is ever missed, this
    // still ends the loading state once Firebase has restored the session.
    void auth
      .authStateReady()
      .then(() => {
        if (!settled) publish("authStateReady");
      })
      .catch((error) => console.error("[auth] authStateReady failed", error));
    const slow = setTimeout(() => {
      if (!settled)
        console.warn(
          `[auth] Firebase hasn’t reported whether anyone is signed in after ${SLOW_AUTH_MS / 1000}s. Pages wait on this, so they show the loading screen. Check the network tab for identitytoolkit / securetoken requests.`,
        );
    }, SLOW_AUTH_MS);
    // Pages restored from the back/forward cache skip effects; re-check then.
    const restore = (event: PageTransitionEvent) => {
      debugLog("auth", "page shown", { fromCache: event.persisted });
      void auth.authStateReady().then(() => publish("pageshow"));
    };
    window.addEventListener("pageshow", restore);
    return () => {
      active = false;
      clearTimeout(slow);
      unsubscribe();
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  return <AuthContext value={state}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  return use(AuthContext);
}
