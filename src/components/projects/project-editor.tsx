"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import Link from "next/link";
import { ReadOnlyEditor } from "@/components/editor/screenplay-editor";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/auth-provider";
import { ScreenplayEditor } from "@/components/editor/screenplay-editor";
import { firebaseDb } from "@/lib/firebase/client";
import { loadProjectDraft, type CloudDraft } from "@/lib/projects/client";
import { validProjectId } from "@/lib/projects/routes";
import { useRedirect } from "@/components/auth/use-redirect";
import { debugLog, describeUser, watchSlow } from "@/lib/debug";
import {
  canEditBranch,
  isRole,
  type BranchAccessInfo,
  type MemberAccess,
} from "@/lib/projects/permissions";
export function EditorRoute() {
  const { user, loading } = useAuth();
  const params = useSearchParams();
  const pid = params.get("project");
  const branch = params.get("branch") || "main";
  useEffect(() => {
    debugLog(
      "route",
      `editor: ${loading ? "waiting for sign-in state" : "auth resolved"}`,
      { ...describeUser(user), project: pid, branch },
    );
  }, [loading, user, pid, branch]);
  useRedirect(
    loading
      ? null
      : !user
        ? "/"
        : !user.isAnonymous && !pid
          ? "/dashboard"
          : null,
    !user ? "signed out in the editor" : "no project chosen",
  );
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
    member: MemberAccess;
    branch: BranchAccessInfo;
  } | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const membership = watchSlow("data", `editor: membership in ${projectId}`);
    const stop = onSnapshot(
      doc(firebaseDb(), "projects", projectId, "members", uid),
      (snapshot) => {
        const run = ++generation;
        const data = snapshot.data();
        membership(`${data?.role ?? "no access"}`);
        debugLog("data", "editor: membership", {
          project: projectId,
          exists: snapshot.exists(),
          role: data?.role ?? null,
          fromCache: snapshot.metadata.fromCache,
        });
        if (!snapshot.exists() || !isRole(data?.role)) {
          setState(null);
          setDenied(true);
          return;
        }
        const member: MemberAccess = { role: data.role, access: data.access };
        setDenied(false);
        setState(null);
        const drafted = watchSlow("data", `editor: draft of ${branch}`);
        const described = watchSlow("data", `editor: branch ${branch}`);
        Promise.all([
          loadProjectDraft(projectId, branch).then((draft) => {
            drafted(`version ${draft.version}`);
            return draft;
          }),
          getDoc(
            doc(firebaseDb(), "projects", projectId, "branches", branch),
          ).then((info) => {
            described(info.exists() ? "found" : "missing");
            return info;
          }),
        ])
          .then(([draft, info]) => {
            const branchInfo = {
              name: branch,
              protected: info.data()?.protected === true,
              createdBy: info.data()?.createdBy ?? null,
              dedicatedTo: info.data()?.dedicatedTo ?? null,
            };
            if (active && run === generation)
              setState({ draft, member, branch: branchInfo });
          })
          .catch((failure) => {
            drafted("failed");
            described("failed");
            console.error("[data] editor: loading the project failed", failure);
            if (active && run === generation) {
              setState(null);
              setDenied(true);
            }
          });
      },
      (failure) => {
        membership("failed");
        console.error("[data] editor: membership check failed", failure);
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
  const project = {
    id: projectId,
    uid,
    initial: state.draft,
    branch,
    role: state.member.role,
    member: state.member,
    branchInfo: state.branch,
  };
  // Readers and commenters see the committed pages. Editors on a branch they
  // can't edit (main without permission, or another editor's branch) do too,
  // but keep branching and merging.
  if (!canEditBranch(state.member, uid, state.branch))
    return (
      <ReadOnlyEditor
        key={`${branch}:${state.draft.baseCommit}`}
        project={{
          ...project,
          locked:
            state.member.role === "owner" || state.member.role === "editor",
        }}
      />
    );
  return <ScreenplayEditor project={project} />;
}
