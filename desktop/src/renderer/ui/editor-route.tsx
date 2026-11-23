/** /editor?project=<id>&branch=<name>: open a project from this device's
 * library in the shared screenplay editor. */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import {
  type EditorHost,
  EditorView,
  ReadOnlyEditor,
} from "@/components/editor/screenplay-editor";
import type { EditorProject } from "@/components/editor/use-project-draft";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import { loadProjectDraft, type RevisionSummary } from "@/lib/projects/client";
import { validProjectId } from "@/lib/projects/routes";
import { isBranchName } from "../../core/snapshot";
import { projectStatus } from "../../core/sync/status";
import {
  LOCAL_SCOPE,
  type ProjectMeta,
  type ProjectRef,
} from "../../core/types";
import { emitChanged, isLocalId, onChanged, onSaved } from "../data/projects";
import { deviceSettings, projectApi } from "../platform/bridge";
import { useOnline } from "../platform/online";
import { syncController } from "../sync/controller";
import { SyncButton } from "./sync-dialog";
import { useDeviceDraft } from "./use-device-draft";

/** How long opening a project waits for a sync before showing what is on the device. */
const OPEN_SYNC_WAIT_MS = 6000;
const BACKGROUND_SYNC_MS = 5 * 60 * 1000;
const IDLE_UPLOAD_MS = 45 * 1000;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "This project could not be opened.";

export function EditorRoute() {
  const { user, loading } = useAuth();
  const params = useSearchParams();
  const projectId = params.get("project");
  const branch = params.get("branch");
  const valid =
    validProjectId(projectId) && (branch === null || isBranchName(branch));
  const local = valid && isLocalId(projectId);
  const scope = local
    ? LOCAL_SCOPE
    : user && !user.isAnonymous
      ? user.uid
      : null;
  const projectRef = useMemo(
    () => (valid && scope ? { scope, id: projectId } : null),
    [valid, scope, projectId],
  );
  if (!valid) return <Unavailable />;
  if (!local && loading) return <TypewriterLoader />;
  if (!projectRef)
    return (
      <Unavailable message="This project belongs to a DraftBranch account. Sign in from the library to open it." />
    );
  return (
    <OpenProject
      key={`${projectRef.scope}/${projectRef.id}/${branch ?? ""}`}
      projectRef={projectRef}
      branch={branch}
    />
  );
}

function Unavailable({ message }: { message?: string }) {
  return (
    <main className="access-state">
      <div className="eyebrow">LIBRARY</div>
      <h1>Project unavailable</h1>
      <p>
        {message ??
          "This project isn’t on this device, or the link is not valid."}
      </p>
      <Link className="primary-action" href="/">
        Back to the library
      </Link>
    </main>
  );
}

interface Opened {
  project: EditorProject;
  meta: ProjectMeta;
  writerName: string;
}
function OpenProject({
  projectRef,
  branch,
}: {
  projectRef: ProjectRef;
  branch: string | null;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    const api = projectApi(projectRef);
    (async () => {
      const first = await api.state();
      const cloud = first.meta.cloud;
      const name = branch ?? first.meta.lastBranch ?? first.meta.defaultBranch;
      if (cloud && navigator.onLine) {
        // Bring the project up to date before the editor takes hold of the
        // branch. A slow connection does not keep the writer waiting: after a
        // moment the editor opens with what is here, and the sync carries on
        // without touching the open branch.
        setNote("Syncing with DraftBranch cloud…");
        await Promise.race([
          syncController.sync(projectRef, { focus: [name] }),
          new Promise((resolve) => setTimeout(resolve, OPEN_SYNC_WAIT_MS)),
        ]);
      }
      if (!active) return;
      // From here on, sync leaves this branch alone until the editor closes.
      release = syncController.hold(projectRef, name);
      const state = await api.state();
      if (state.meta.cloud && !state.meta.cloud.cloned)
        throw new Error(
          "This project hasn’t finished downloading. Connect to the internet and open it again.",
        );
      if (!state.branches.some((b) => b.name === name))
        throw new Error(`There is no branch called “${name}” in this project.`);
      const initial = await loadProjectDraft(projectRef.id, name);
      const meta = await api.setMeta({
        lastBranch: name,
        openedAt: Date.now(),
      });
      const settings = await deviceSettings();
      if (!active) return;
      const access =
        meta.cloud?.access === "revoked"
          ? "reviewer"
          : (meta.cloud?.role ?? "owner");
      setOpened({
        project: {
          id: projectRef.id,
          uid: projectRef.scope,
          initial,
          branch: name,
          role: access,
        },
        meta,
        writerName: settings.writerName,
      });
    })().catch((problem) => {
      if (active) setError(messageOf(problem));
    });
    return () => {
      active = false;
      release?.();
    };
  }, [projectRef, branch]);

  if (error) return <Unavailable message={error} />;
  if (!opened)
    return (
      <div className="opening">
        <TypewriterLoader />
        {note && <p role="status">{note}</p>}
      </div>
    );
  return <Mounted projectRef={projectRef} {...opened} />;
}

/** Revisions made here that the cloud does not have, for the history graph. */
function useUnpublished(projectRef: ProjectRef, cloud: boolean): Set<string> {
  const [unpublished, setUnpublished] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!cloud) return;
    let active = true;
    const api = projectApi(projectRef);
    const load = async () => {
      const status = projectStatus(await api.state(), await api.commits());
      if (active) setUnpublished(status.unpublished);
    };
    void load().catch(() => {});
    const stop = onChanged(projectRef, () => void load().catch(() => {}));
    return () => {
      active = false;
      stop();
    };
  }, [projectRef, cloud]);
  return unpublished;
}

function Mounted({
  projectRef,
  project,
  meta,
  writerName,
}: Opened & { projectRef: ProjectRef }) {
  const online = useOnline();
  const { user } = useAuth();
  const cloud = !!meta.cloud;
  const revoked = meta.cloud?.access === "revoked";
  const unpublished = useUnpublished(projectRef, cloud);
  const readOnly = project.role === "reviewer";

  // Signing out closes a pulled project: its copy belongs to that account.
  useEffect(() => {
    if (cloud && (!user || user.uid !== projectRef.scope))
      window.location.assign("/");
  }, [cloud, user, projectRef.scope]);

  // Keep a pulled project in step while it is open, without disturbing typing.
  const lastSync = useRef(Date.now());
  useEffect(() => {
    if (!cloud || revoked) return;
    const background = () => {
      if (!navigator.onLine || document.hidden) return;
      lastSync.current = Date.now();
      void syncController.sync(projectRef, { focus: [project.branch] });
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    // After writing pauses, send the working draft so the web app has it too.
    const stopChanges = onSaved(projectRef, () => {
      clearTimeout(idle);
      idle = setTimeout(background, IDLE_UPLOAD_MS);
    });
    const interval = setInterval(background, BACKGROUND_SYNC_MS);
    const visible = () => {
      if (
        !document.hidden &&
        Date.now() - lastSync.current > BACKGROUND_SYNC_MS / 2
      )
        background();
    };
    window.addEventListener("online", background);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(idle);
      clearInterval(interval);
      stopChanges();
      window.removeEventListener("online", background);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [cloud, revoked, projectRef, project.branch]);

  const host = useMemo<EditorHost>(
    () => ({
      home: { href: "/", label: "← Library" },
      collaboration: cloud && !revoked && online,
      badge: cloud
        ? revoked
          ? "READ-ONLY COPY"
          : "SYNCED COPY"
        : "ON THIS DEVICE",
      storageNote: cloud
        ? "Your draft saves on this device as you type, and syncs with DraftBranch cloud whenever you’re online. You can keep writing and committing without a connection."
        : "Your draft saves on this device as you type. This project lives in the DraftBranch app on this computer; export a copy whenever you want one elsewhere.",
      guest: { name: writerName || "This device", detail: "Local workspace" },
      versionControl: {
        savedLabel: "Draft saved on this device",
        savingLabel: "Saving draft…",
        repositoryLabel: cloud
          ? "Synced with DraftBranch cloud"
          : "On this device",
        mergeRequests: cloud,
        commitLabels: {
          busy: "Committing…",
          progress: "Committing revision…",
          done: "Revision committed. Reopening your draft…",
        },
        revisionTag: (commit: RevisionSummary) =>
          unpublished.has(commit.oid) ? "not published yet" : undefined,
      },
    }),
    [cloud, revoked, online, writerName, unpublished],
  );

  if (readOnly)
    return (
      <ReadOnlyEditor
        key={`${project.branch}:${project.initial.baseCommit}`}
        project={project}
        host={{
          ...host,
          actions: cloud ? (
            <SyncButton
              projectRef={projectRef}
              branch={project.branch}
              revoked={revoked}
            />
          ) : undefined,
        }}
      />
    );
  return (
    <Writer
      projectRef={projectRef}
      project={project}
      host={host}
      cloud={cloud}
    />
  );
}

function Writer({
  projectRef,
  project,
  host,
  cloud,
}: {
  projectRef: ProjectRef;
  project: EditorProject;
  host: EditorHost;
  cloud: boolean;
}) {
  const state = useDeviceDraft(project);
  const { flush, canPublish } = state;
  // Sync may move this branch only once everything typed is on disk.
  const settle = async () => {
    await flush();
    return canPublish();
  };
  useEffect(() => () => emitChanged(projectRef), [projectRef]);
  return (
    <EditorView
      state={state}
      project={project}
      getVersion={state.getVersion}
      canPublish={state.canPublish}
      host={{
        ...host,
        actions: cloud ? (
          <SyncButton
            projectRef={projectRef}
            branch={project.branch}
            beforeSync={settle}
          />
        ) : undefined,
      }}
    />
  );
}
