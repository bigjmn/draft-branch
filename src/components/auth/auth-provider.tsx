"use client";
import { onIdTokenChanged, type User } from "firebase/auth";
import { createContext, use, useEffect, useState } from "react";
import { firebaseAuth } from "@/lib/firebase/client";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    revision: 0,
  });
  useEffect(() => {
    const auth = firebaseAuth();
    let active = true;
    const publish = () => {
      if (active)
        setState((previous) => ({
          user: auth.currentUser,
          loading: false,
          revision: previous.revision + 1,
        }));
    };
    const unsubscribe = onIdTokenChanged(auth, publish);
    const restore = () => {
      void auth.authStateReady().then(publish);
    };
    window.addEventListener("pageshow", restore);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  return <AuthContext value={state}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  return use(AuthContext);
}
