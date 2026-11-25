"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { sendEmailVerification, signOut } from "firebase/auth";
import { useAuth } from "@/components/auth/auth-provider";
import { AuthPanel, type AuthMode } from "@/components/auth/auth-panel";
import { ThemeToggle } from "@/components/theme/theme-provider";
import { firebaseAuth } from "@/lib/firebase/client";
import {
  acceptProjectInvitation,
  getProjectInvitation,
  readSharedProject,
  type InvitationAccess,
  type InvitationInfo,
} from "@/lib/projects/client";
import { validProjectId, projectHref } from "@/lib/projects/routes";
import { ROLE_LABELS } from "@/lib/projects/permissions";
import type { Draft } from "@/lib/editor/types";
import { ReadOnlyEditor } from "@/components/editor/screenplay-editor";
import type { Branch } from "@/lib/projects/client";

export function InvitationPage() {
  const params = useSearchParams(),
    router = useRouter();
  const { user, loading } = useAuth();
  const [access, setAccess] = useState<InvitationAccess | null>(null);
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [branch, setBranch] = useState("main");
  const [commitId, setCommitId] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [showAuth, setShowAuth] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const projectId = params.get("project"),
      invitationId = params.get("invitation");
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    if (
      !validProjectId(projectId) ||
      !validProjectId(invitationId) ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      setUnavailable(true);
      return;
    }
    setAccess({ projectId, invitationId, token });
  }, [params]);
  useEffect(() => {
    if (!access) return;
    let active = true,
      running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        const result = reading
          ? await readSharedProject({ ...access!, branchId: branch })
          : await getProjectInvitation(access!);
        if (active) {
          setInfo(result);
          setUnavailable(false);
          if ("draft" in result) {
            const shared = result as Awaited<
              ReturnType<typeof readSharedProject>
            >;
            setDraft(shared.draft);
            setCommitId(shared.commitId);
            setBranches(shared.branches);
          }
        }
      } catch {
        if (active) {
          setDraft(null);
          setInfo(null);
          setUnavailable(true);
        }
      } finally {
        running = false;
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 30000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [access, reading, branch]);
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(
      () => {
        setDraft(null);
        setInfo(null);
        setUnavailable(true);
      },
      Math.max(0, Math.min(info.expiresAt - Date.now(), 2147483647)),
    );
    return () => clearTimeout(timer);
  }, [info]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn’t complete that action.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    const current = firebaseAuth().currentUser;
    if (!current || current.isAnonymous || !access) return;
    await current.reload();
    await current.getIdToken(true);
    if (!current.emailVerified) {
      setError(
        "Verify the invited email address first. Then choose Accept invitation again.",
      );
      return;
    }
    const accepted = await acceptProjectInvitation(
      access.projectId,
      access.invitationId,
      access.token,
    );
    // An editor with a dedicated branch starts on it.
    router.replace(
      projectHref(access.projectId) +
        (accepted.branch
          ? `&branch=${encodeURIComponent(accepted.branch)}`
          : ""),
    );
  }
  const registered = user && !user.isAnonymous;
  if (!unavailable && (!info || loading)) return <TypewriterLoader />;
  if (reading && !unavailable && access && info) {
    if (!draft) return <TypewriterLoader />;
    return (
      <ReadOnlyEditor
        key={`${branch}:${commitId}`}
        project={{
          id: access.projectId,
          uid: user?.uid || "",
          branch,
          role: "reviewer",
          initial: {
            draft: { ...draft, schemaVersion: 1 },
            baseCommit: commitId,
            head: commitId,
            version: 0,
          },
        }}
        reader={{
          access,
          branches,
          onBranchChange: (next) => {
            setDraft(null);
            setBranch(next);
          },
          onContribute: () => setReading(false),
        }}
      />
    );
  }

  return (
    <main className="invitation-page">
      <header className="invitation-header">
        <Link href="/">DraftBranch</Link>
        <ThemeToggle />
      </header>
      {unavailable ? (
        <section className="invitation-card">
          <h1>Invitation unavailable</h1>
          <p>
            The link may be invalid, expired, or revoked. Check your connection
            or ask the owner for a new invitation.
          </p>
        </section>
      ) : !info || loading ? (
        <TypewriterLoader />
      ) : (
        <>
          <section className="invitation-card">
            <p className="eyebrow">
              YOU’RE INVITED · {ROLE_LABELS[info.role].toUpperCase()}
            </p>
            <h1>{info.title}</h1>
            <p>
              {summary(info)}{" "}
              {info.requireSignIn
                ? info.role === "editor" && info.access?.branch
                  ? `Sign in with the invited email and accept, and the branch ${info.access.branch} is made for you to write on. You can read every other branch.`
                  : `Sign in with the invited email and accept the invitation to ${
                      info.role === "editor"
                        ? "contribute"
                        : info.role === "commenter"
                          ? "comment on the pages"
                          : "read the project"
                    }.`
                : info.role === "editor"
                  ? info.access?.branch
                    ? `Accept with the invited email and the branch ${info.access.branch} is made for you to write on. You can read every other branch, or continue with read-only access for now.`
                    : "Sign in to contribute, or continue with read-only access."
                  : info.role === "commenter"
                    ? "Sign in to comment on the pages, or continue with read-only access."
                    : "Read without an account, or sign in to keep this project in your dashboard."}
            </p>
            {info.note && (
              <blockquote className="invitation-note">
                <span>A note from {info.ownerName}</span>
                {info.note}
              </blockquote>
            )}
            <p className="share-description">
              {info.requireSignIn
                ? "The owner asked that only the invited email address, signed in, can open this project."
                : "Read access includes all committed branches and their history."}{" "}
              This link expires {new Date(info.expiresAt).toLocaleDateString()}.
            </p>
            {!reading && !info.requireSignIn && (
              <button
                className="primary-action"
                onClick={() => {
                  setReading(true);
                  setShowAuth(false);
                }}
              >
                Continue with read-only access
              </button>
            )}
            {registered ? (
              <div className="invitation-actions">
                <p>
                  Signed in as {user.email}. Use the email address that received
                  this invitation.
                </p>
                <button
                  disabled={busy}
                  className="primary-action"
                  onClick={() => void run(accept)}
                >
                  Accept invitation
                </button>
                {!user.emailVerified && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await sendEmailVerification(user);
                        setNotice(
                          "Verification email sent. Follow its link, then return here and accept the invitation.",
                        );
                      })
                    }
                  >
                    Send verification email
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await signOut(firebaseAuth());
                      setShowAuth(true);
                    })
                  }
                >
                  Use another account
                </button>
              </div>
            ) : (
              <div className="invitation-actions">
                <button
                  onClick={() => {
                    setMode("signin");
                    setShowAuth(true);
                  }}
                >
                  Sign in
                </button>
                <button
                  onClick={() => {
                    setMode("signup");
                    setShowAuth(true);
                  }}
                >
                  Create an account
                </button>
              </div>
            )}
            {error && (
              <p className="share-error" role="alert">
                {error}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
          </section>
          {showAuth && !registered && (
            <div className="invitation-auth">
              <AuthPanel mode={mode} onModeChange={setMode} />
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** The invitation's first line, matching the email. */
function summary(info: InvitationInfo) {
  if (info.role === "editor" && info.access?.branch)
    return `${info.ownerName} invited you to edit with dedicated branch ${info.access.branch}.`;
  if (info.role === "editor") return `${info.ownerName} invited you to edit.`;
  if (info.role === "commenter")
    return `${info.ownerName} invited you to comment.`;
  return `${info.ownerName} invited you to read.`;
}
