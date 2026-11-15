"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "./auth-provider";

/** Client-side gate: the app is statically exported, so there is no server check. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);
  if (!user)
    return (
      <main className="loading-state" role="status">
        Opening your writing room…
      </main>
    );
  return children;
}
