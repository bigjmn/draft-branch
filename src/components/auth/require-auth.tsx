"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import { useAuth } from "./auth-provider";
import { useRedirect } from "./use-redirect";

/** Client-side gate: the app is statically exported, so there is no server check. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  useRedirect(
    !loading && !user ? "/" : null,
    "signed out on a members-only page",
  );
  if (!user) return <TypewriterLoader />;
  return children;
}
