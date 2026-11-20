"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import Link from "next/link";
import { ReadOnlyEditor } from "@/components/editor/screenplay-editor";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/auth-provider";
import { ScreenplayEditor } from "@/components/editor/screenplay-editor";
import { firebaseDb } from "@/lib/firebase/client";
import { loadProjectDraft, type CloudDraft } from "@/lib/projects/client";
import { validProjectId } from "@/lib/projects/routes";
export function EditorRoute() {
  const { user, loading } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const pid = params.get("project");
  const branch = params.get("branch") || "main";
  useEffect(() => {
    if (!loading) {
      if (!user) router.replace("/");
      else if (!user.isAnonymous && !pid) router.replace("/dashboard");
    }
  }, [loading, user, pid, router]);
  if (loading || !user) return <TypewriterLoader />;
  if (pid) {
    if (
      user.isAnonymous ||
      !validProjectId(pid) ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(branch) ||
      branch.length > 64
    )
      return <Unavailable />;
    return (
      <MemberEditor
        key={`${user.uid}:${pid}:${branch}`}
        uid={user.uid}
        projectId={pid}
        branch={branch}
      />
    );
  }
  return user.isAnonymous ? (
    <ScreenplayEditor key={user.uid} />
  ) : (
    <TypewriterLoader />
  );
}
function Unavailable() {
  return (
    <main className="access-state">
      <div className="eyebrow">PRIVATE PROJECT</div>
      <h1>Project unavailable</h1>
      <p>You may not have access to this project, or it may no longer exist.</p>
      <Link className="primary-action" href="/dashboard">
        Back to dashboard
      </Link>
    </main>
  );
}
function MemberEditor({
  uid,
  projectId,
  branch,
}: {
  uid: string;
  projectId: string;
  branch: string;
}) {
  const [state, setState] = useState<{
    draft: CloudDraft;
    role: string;
  } | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const stop = onSnapshot(
      doc(firebaseDb(), "projects", projectId, "members", uid),
      (snapshot) => {
        const run = ++generation;
        const role = snapshot.data()?.role;
        if (
          !snapshot.exists() ||
          !["owner", "editor", "reviewer"].includes(role)
        ) {
          setState(null);
          setDenied(true);
          return;
        }
        setDenied(false);
        setState(null);
        loadProjectDraft(projectId, branch)
          .then((draft) => {
            if (active && run === generation) setState({ draft, role });
          })
          .catch(() => {
            if (active && run === generation) {
              setState(null);
              setDenied(true);
            }
          });
      },
      () => {
        setState(null);
        setDenied(true);
      },
    );
    return () => {
      active = false;
      generation++;
      stop();
    };
  }, [uid, projectId, branch]);
  if (denied) return <Unavailable />;
  if (!state) return <TypewriterLoader />;
  if (state.role === "reviewer")
    return (
      <ReadOnlyEditor
        key={`${branch}:${state.draft.baseCommit}`}
        project={{
          id: projectId,
          uid,
          initial: state.draft,
          branch,
          role: state.role,
        }}
      />
    );
  return (
    <ScreenplayEditor
      project={{
        id: projectId,
        uid,
        initial: state.draft,
        branch,
        role: state.role,
      }}
    />
  );
}
