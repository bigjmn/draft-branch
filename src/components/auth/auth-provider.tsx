"use client";
import { onAuthStateChanged, type User } from "firebase/auth";
import { createContext, use, useEffect, useState } from "react";
import { firebaseAuth } from "@/lib/firebase/client";

interface AuthState {
  user: User | null;
  /** True until Firebase has restored (or ruled out) a persisted session. */
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });
  useEffect(
    () =>
      onAuthStateChanged(firebaseAuth(), (user) =>
        setState({ user, loading: false }),
      ),
    [],
  );
  return <AuthContext value={state}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  return use(AuthContext);
}
