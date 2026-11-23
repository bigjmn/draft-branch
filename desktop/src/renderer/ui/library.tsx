/** The library: every project on this device, plus (when signed in) the
 * account's cloud projects that can be pulled onto it. */
import { signOut } from "firebase/auth";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { FdxFileInput } from "@/components/editor/fdx-import";
import { ThemeToggle } from "@/components/theme/theme-provider";
import { BetaBadge } from "@/components/ui/beta-badge";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import type { Draft } from "@/lib/editor/types";
import { firebaseAuth } from "@/lib/firebase/client";
import { initializeImportedProject } from "@/lib/projects/initialize-import";
import {
  LOCAL_SCOPE,
  type ProjectRef,
  type ProjectSummary,
} from "../../core/types";
import { web } from "../data/cloud";
import { emitChanged, keyOf, onChanged } from "../data/projects";
import type { AppInfo } from "../../shared/bridge";
import {
  DeviceError,
  device,
  deviceSettings,
  isMac,
  updateDeviceSettings,
} from "../platform/bridge";
import { OPEN_SYNC } from "../platform/events";
import { cloudConfigured, useOnline } from "../platform/online";
import { editorHref, navigate } from "../router";
import {
  describeFailure,
  syncController,
  useSyncView,
} from "../sync/controller";
import { AccountDialog } from "./account";
import { SyncDialog } from "./sync-dialog";

type CloudProject = web.Project;
type Filter = "all" | "device" | "cloud";
const RESYNC_AFTER_MS = 2 * 60 * 1000;
const ROLE_LABEL = {
  owner: "Owner",
  editor: "Editor",
  reviewer: "Reader",
} as const;
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function ago(time: number | undefined): string {
  if (!time) return "never";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} hr ago`;
  return new Date(time).toLocaleDateString();
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Library() {
  const { user, loading } = useAuth();
  const online = useOnline();
  const params = useSearchParams();
  const uid = user && !user.isAnonymous ? user.uid : null;
  const [local, setLocal] = useState<ProjectSummary[] | null>(null);
  const [pulled, setPulled] = useState<ProjectSummary[]>([]);
  const [cloud, setCloud] = useState<CloudProject[] | null>(null);
  const [cloudState, setCloudState] = useState<
    "off" | "loading" | "ready" | "failed"
  >("off");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<
    | null
    | { kind: "new" }
    | { kind: "account" }
    | { kind: "settings" }
    | { kind: "sync"; ref: ProjectRef }
    | { kind: "remove"; project: ProjectSummary }
    | { kind: "sign-out" }
  >(null);

  const reload = useCallback(async () => {
    try {
      const [mine, theirs] = await Promise.all([
        device({ kind: "library.list", scope: LOCAL_SCOPE }),
        uid
          ? device({ kind: "library.list", scope: uid })
          : Promise.resolve([]),
      ]);
      setLocal(mine);
      setPulled(theirs);
      setError("");
    } catch (problem) {
      setLocal((current) => current ?? []);
      setError(
        messageOf(problem, "The library on this device could not be read."),
      );
    }
  }, [uid]);
  useEffect(() => {
    void reload();
    return onChanged(null, () => void reload());
  }, [reload]);
  useEffect(() => {
    document.title = "DraftBranch";
  }, []);

  // File → New Project arrives as /?new=1.
  useEffect(() => {
    if (!params.has("new")) return;
    setDialog({ kind: "new" });
    navigate("/", { replace: true });
  }, [params]);

  // The account's projects in the cloud, live while online.
  useEffect(() => {
    if (!uid || !online || !cloudConfigured) {
      setCloud(null);
      setCloudState("off");
      return;
    }
    setCloudState("loading");
    try {
      return web.watchProjects(
        (projects) => {
          setCloud(projects);
          setCloudState("ready");
        },
        () => {
          setCloud(null);
          setCloudState("failed");
        },
      );
    } catch {
      setCloudState("failed");
    }
  }, [uid, online]);

  // Quietly bring pulled projects up to date while the library is showing.
  const pulledIds = pulled.map((p) => p.meta.id).join(",");
  const pulledNow = useRef(pulled);
  pulledNow.current = pulled;
  useEffect(() => {
    if (!uid || !online) return;
    let cancelled = false;
    void (async () => {
      for (const project of pulledNow.current) {
        if (cancelled) return;
        const link = project.meta.cloud;
        if (!link || link.access === "revoked") continue;
        if (Date.now() - (link.lastSyncedAt ?? 0) < RESYNC_AFTER_MS) continue;
        await syncController.sync(project.ref);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, online, pulledIds]);

  // File > Sync with DraftBranch Cloud, chosen while the library is showing.
  useEffect(() => {
    const syncAll = () => {
      if (!navigator.onLine) return;
      for (const project of pulledNow.current)
        if (project.meta.cloud && project.meta.cloud.access !== "revoked")
          void syncController.sync(project.ref);
    };
    window.addEventListener(OPEN_SYNC, syncAll);
    return () => window.removeEventListener(OPEN_SYNC, syncAll);
  }, []);

  const onDevice = useMemo(
    () =>
      [...(local ?? []), ...pulled].sort(
        (a, b) =>
          (b.meta.openedAt ?? b.meta.updatedAt) -
          (a.meta.openedAt ?? a.meta.updatedAt),
      ),
    [local, pulled],
  );
  const notPulled = useMemo(() => {
    const here = new Set(pulled.map((p) => p.meta.id));
    return (cloud ?? []).filter((p) => !here.has(p.projectId));
  }, [cloud, pulled]);
  const matches = (title: string) =>
    title.toLowerCase().includes(query.trim().toLowerCase());
  const shownDevice = onDevice.filter(
    (p) =>
      matches(p.meta.title) &&
      (filter === "all" ||
        (filter === "device" ? !p.meta.cloud : !!p.meta.cloud)),
  );
  const shownCloud =
    filter === "device" ? [] : notPulled.filter((p) => matches(p.title));
  const unsynced = pulled.filter((p) => p.unpublished || p.drafts).length;
  const name = user?.displayName || user?.email || "Account";

  if (local === null || loading) return <TypewriterLoader />;
  const empty = !onDevice.length && !notPulled.length;
  return (
    <div className="dashboard library">
      <nav className="workspace-nav" aria-label="Library">
        <Link href="/" className="brand">
          <span className="brand-icon">d.</span> DraftBranch <BetaBadge />
        </Link>
        <div className="workspace-account">
          {!online && (
            <span
              className="offline-chip"
              title="Your work is saved on this device."
            >
              Offline
            </span>
          )}
          <ThemeToggle />
          <button onClick={() => setDialog({ kind: "settings" })}>
            Settings
          </button>
          {uid ? (
            <>
              <span className="workspace-name" title={user?.email ?? undefined}>
                {name}
              </span>
              <button
                onClick={() =>
                  unsynced
                    ? setDialog({ kind: "sign-out" })
                    : void signOut(firebaseAuth())
                }
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              className="library-sign-in"
              onClick={() => setDialog({ kind: "account" })}
            >
              Sign in
            </button>
          )}
        </div>
      </nav>
      <main className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <div className="eyebrow">YOUR WRITING ROOM</div>
            <h1>Let’s get to work.</h1>
            <p>
              {uid
                ? "Projects on this computer and in your DraftBranch account. Pulled projects keep working offline."
                : "Projects on this computer. No account needed; sign in to pull the ones in your DraftBranch account."}
            </p>
          </div>
          <button
            className="primary-action"
            onClick={() => setDialog({ kind: "new" })}
          >
            + New project
          </button>
        </div>
        <div className="project-tools">
          <div className="project-filters" aria-label="Filter projects">
            {(
              [
                ["all", "All projects"],
                ["device", "Only on this device"],
                ["cloud", "DraftBranch cloud"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="project-search"
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {error && (
          <p className="workspace-message" role="alert">
            {error}
          </p>
        )}
        {shownDevice.length + shownCloud.length ? (
          <div className="project-grid">
            {shownDevice.map((project) => (
              <DeviceCard
                key={keyOf(project.ref)}
                project={project}
                online={online}
                onSync={() => setDialog({ kind: "sync", ref: project.ref })}
                onRemove={() => setDialog({ kind: "remove", project })}
              />
            ))}
            {uid &&
              shownCloud.map((project) => (
                <CloudCard
                  key={project.projectId}
                  uid={uid}
                  project={project}
                />
              ))}
          </div>
        ) : (
          <section className="empty-projects">
            <span className="empty-mark" aria-hidden="true">
              ▤
            </span>
            <h2>
              {empty
                ? "A blank page. A world of possibility."
                : "No matching projects"}
            </h2>
            <p>
              {empty
                ? uid
                  ? "Start a screenplay on this computer. Projects in your DraftBranch account appear here, ready to pull."
                  : "Start a screenplay on this computer, or sign in to pull your DraftBranch projects."
                : filter === "cloud" && !uid
                  ? "Sign in to see the projects in your DraftBranch account."
                  : "Try another search or filter."}
            </p>
            {empty && (
              <div className="empty-actions">
                <button
                  className="primary-action"
                  onClick={() => setDialog({ kind: "new" })}
                >
                  Create your first project
                </button>
                {!uid && (
                  <button onClick={() => setDialog({ kind: "account" })}>
                    Sign in to DraftBranch
                  </button>
                )}
              </div>
            )}
            {!empty && filter === "cloud" && !uid && (
              <button
                className="primary-action"
                onClick={() => setDialog({ kind: "account" })}
              >
                Sign in
              </button>
            )}
          </section>
        )}
        <p className="workspace-footnote">
          {uid && !online
            ? "You’re offline. Projects in your account that aren’t on this device will appear when you reconnect."
            : cloudState === "loading"
              ? "Checking your DraftBranch account for projects…"
              : cloudState === "failed"
                ? "Couldn’t load the projects in your DraftBranch account. Projects already on this device are unaffected."
                : "Projects on this device are stored inside the DraftBranch app. Open Settings to see where."}
        </p>
      </main>

      {dialog?.kind === "new" && (
        <NewProject
          signedIn={!!uid}
          online={online}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "account" && (
        <AccountDialog onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "settings" && (
        <Settings onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "sync" && (
        <SyncDialog
          projectRef={dialog.ref}
          onClose={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveProject
          project={dialog.project}
          onClose={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog?.kind === "sign-out" && (
        <Confirm
          title="Sign out?"
          action="Sign out"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void signOut(firebaseAuth());
          }}
        >
          {plural(unsynced, "project")} {unsynced === 1 ? "has" : "have"} work
          that hasn’t reached the cloud yet. It stays on this computer and syncs
          after you sign in again with this account.
        </Confirm>
      )}
    </div>
  );
}

/** A project that is on this device: made here, or pulled from the cloud. */
function DeviceCard({
  project,
  online,
  onSync,
  onRemove,
}: {
  project: ProjectSummary;
  online: boolean;
  onSync: () => void;
  onRemove: () => void;
}) {
  const { meta, ref } = project;
  const link = meta.cloud;
  const view = useSyncView(link ? ref : null);
  const failure =
    view.report && !view.report.ok ? describeFailure(view.report) : null;
  let state: string;
  if (!link) state = `Edited ${ago(meta.updatedAt)}`;
  else if (!link.cloned) state = "Not finished downloading";
  else if (link.access === "revoked") state = "Access removed · read-only copy";
  else if (view.running) state = view.message || "Syncing…";
  else if (project.unpublished || project.incoming)
    state = [
      project.unpublished ? `↑ ${project.unpublished} to publish` : "",
      project.incoming ? `↓ ${project.incoming} to bring in` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  else state = `Synced ${ago(link.lastSyncedAt)}`;
  const openable = !link || link.cloned;
  return (
    <div className="project-card-wrap">
      <Link
        className="project-card"
        href={editorHref(meta.id)}
        aria-disabled={!openable}
        onClick={(event) => {
          if (!openable) event.preventDefault();
        }}
      >
        <div className="project-card-top">
          <span className="project-glyph" aria-hidden="true">
            ▤
          </span>
          <span className="project-privacy">
            {link ? `Cloud · ${ROLE_LABEL[link.role]}` : "On this device"}
          </span>
        </div>
        <h2>{meta.title}</h2>
        <p>
          Screenplay · {project.branches}{" "}
          {project.branches === 1 ? "branch" : "branches"}
          {project.drafts ? " · uncommitted changes" : ""}
        </p>
        <div className="project-card-bottom">
          <span>{state}</span>
          <span>{openable ? "Open screenplay ↗" : ""}</span>
        </div>
      </Link>
      {failure && !view.running && (
        <p className="card-note" role="status">
          {failure}
        </p>
      )}
      <div className="card-actions">
        {link && link.access !== "revoked" && (
          <button disabled={!online || view.running} onClick={onSync}>
            {link.cloned ? "Sync" : "Finish downloading"}
          </button>
        )}
        <button onClick={onRemove}>
          {link ? "Remove from this device" : "Delete project"}
        </button>
      </div>
    </div>
  );
}

/** A project in the account that has not been pulled onto this device yet. */
function CloudCard({ uid, project }: { uid: string; project: CloudProject }) {
  const ref = useMemo(
    () => ({ scope: uid, id: project.projectId }),
    [uid, project.projectId],
  );
  const view = useSyncView(ref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pull(open: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const report = await syncController.pull(project);
      if (!report.ok)
        setError(
          describeFailure(report) ??
            "The project could not be pulled. Try again.",
        );
      else if (open) navigate(editorHref(project.projectId));
    } catch (problem) {
      setError(
        messageOf(problem, "The project could not be pulled. Try again."),
      );
    }
    emitChanged(ref);
    setBusy(false);
  }
  return (
    <div className="project-card-wrap">
      <div className="project-card cloud-only">
        <div className="project-card-top">
          <span className="project-glyph" aria-hidden="true">
            ☁
          </span>
          <span className="project-privacy">
            In the cloud · {ROLE_LABEL[project.role]}
          </span>
        </div>
        <h2>{project.title}</h2>
        <p>Not on this device yet. Pull it to read and write offline.</p>
        <div className="project-card-bottom">
          <span>{busy ? view.message || "Pulling…" : "Private project"}</span>
          <button
            className="card-pull"
            disabled={busy}
            onClick={() => void pull(true)}
          >
            {busy ? "Pulling…" : "Pull and open ↓"}
          </button>
        </div>
      </div>
      {error && (
        <p className="card-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function NewProject({
  signedIn,
  online,
  onClose,
}: {
  signedIn: boolean;
  online: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [imported, setImported] = useState<Draft | null>(null);
  const [where, setWhere] = useState<"device" | "cloud">("device");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Retrying the same cloud creation must not make a second project.
  const request = useRef<{ signature: string; id: string } | null>(null);
  const canCloud = signedIn && online && cloudConfigured;
  useEffect(() => dialog.current?.showModal(), []);

  async function create(event: FormEvent) {
    event.preventDefault();
    const value = title.trim();
    if (busy || !value) return;
    setBusy(true);
    setError("");
    try {
      if (where === "device" || !canCloud) {
        const user = firebaseAuth().currentUser;
        const settings = await deviceSettings();
        const meta = await device({
          kind: "library.createLocal",
          input: {
            title: value,
            ...(imported ? { draft: imported } : {}),
            authorName: settings.writerName || user?.displayName || "",
          },
        });
        navigate(editorHref(meta.id));
        return;
      }
      const signature = JSON.stringify({ value, imported });
      if (request.current?.signature !== signature)
        request.current = { signature, id: crypto.randomUUID() };
      const id = request.current.id as ReturnType<typeof crypto.randomUUID>;
      const project = await web.createProject(value, id, imported ?? undefined);
      if (imported) {
        // Same safeguard as the web dashboard: confirm the import really is
        // the project's first draft before opening it.
        const draft = { ...imported, title: value };
        await initializeImportedProject(
          project.head,
          draft,
          () => web.loadProjectDraft(project.projectId, "main"),
          (loaded) =>
            web.saveProjectDraft({
              projectId: project.projectId,
              branchId: "main",
              baseCommit: loaded.baseCommit,
              expectedVersion: loaded.version,
              draft,
              requestId: id + "-import",
            }),
        );
      }
      const report = await syncController.pull({
        projectId: project.projectId,
        title: value,
        role: "owner",
      });
      if (!report.ok)
        throw new Error(
          describeFailure(report) ??
            "The project was created in the cloud but could not be pulled yet. It is in your library to pull.",
        );
      navigate(editorHref(project.projectId));
    } catch (problem) {
      setError(
        problem instanceof DeviceError
          ? problem.message
          : messageOf(problem, "Couldn’t create the project.") +
              (where === "cloud"
                ? " Retry with the same title and file to avoid a duplicate."
                : ""),
      );
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="create-project-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={create}>
        <div className="eyebrow">A NEW BEGINNING</div>
        <h2>Create a project</h2>
        <p>Start with a blank screenplay or import an FDX or PDF file.</p>
        <label htmlFor="project-title">Project title</label>
        <input
          id="project-title"
          autoFocus
          required
          maxLength={200}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Untitled screenplay"
        />
        <FdxFileInput
          disabled={busy}
          onChange={(draft) => {
            setImported(draft);
            if (draft) setTitle(draft.title);
          }}
        />
        <fieldset className="project-where" disabled={busy}>
          <legend>Keep it</legend>
          <label>
            <input
              type="radio"
              name="where"
              checked={where === "device"}
              onChange={() => setWhere("device")}
            />
            <span>
              <strong>On this device</strong>
              <small>Stored inside the app. No account needed.</small>
            </span>
          </label>
          <label aria-disabled={!canCloud}>
            <input
              type="radio"
              name="where"
              disabled={!canCloud}
              checked={where === "cloud" && canCloud}
              onChange={() => setWhere("cloud")}
            />
            <span>
              <strong>In DraftBranch cloud</strong>
              <small>
                {canCloud
                  ? "Private to you until you invite someone. Also kept on this device for offline work."
                  : signedIn
                    ? "Needs a connection."
                    : "Sign in to create cloud projects."}
              </small>
            </span>
          </label>
        </fieldset>
        <p role="alert" className="form-error">
          {error}
        </p>
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-action" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Create project →"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function RemoveProject({
  project,
  onClose,
}: {
  project: ProjectSummary;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { title, cloud } = project.meta;
  const unsynced = project.unpublished + project.drafts;
  // Deleting the only copy takes typing the title; removing a synced copy does not.
  const needsTitle = !cloud || unsynced > 0;
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      className="create-project-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || (needsTitle && confirmation !== title)) return;
          setBusy(true);
          try {
            await device({ kind: "library.remove", ref: project.ref });
            onClose();
          } catch (problem) {
            setError(messageOf(problem, "The project could not be removed."));
            setBusy(false);
          }
        }}
      >
        <h2>{cloud ? "Remove from this device?" : "Delete project?"}</h2>
        {cloud ? (
          <p>
            This removes the copy of <strong>{title}</strong> on this computer.
            The project stays in DraftBranch cloud and can be pulled again.
            {unsynced > 0 && (
              <>
                {" "}
                <strong>
                  It has work that hasn’t reached the cloud (
                  {[
                    project.unpublished
                      ? plural(project.unpublished, "unpublished change")
                      : "",
                    project.drafts ? "writing not yet committed" : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  ). That work will be lost.
                </strong>{" "}
                Sync first to keep it.
              </>
            )}
          </p>
        ) : (
          <p>
            This permanently deletes <strong>{title}</strong> from this
            computer, including every branch and revision. It exists nowhere
            else. Export anything you want to keep first.
          </p>
        )}
        {needsTitle && (
          <label>
            Type “{title}” to confirm
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="danger-action"
            disabled={busy || (needsTitle && confirmation !== title)}
          >
            {busy
              ? "Removing…"
              : cloud
                ? "Remove from this device"
                : "Permanently delete project"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Confirm({
  title,
  action,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  action: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      className="create-project-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2>{title}</h2>
      <p>{children}</p>
      <div className="dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary-action" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </dialog>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    void deviceSettings().then((settings) => setName(settings.writerName));
    void device({ kind: "app.info" }).then(setInfo);
  }, []);
  return (
    <dialog
      ref={dialog}
      className="create-project-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await updateDeviceSettings({ writerName: name });
          setSaved(true);
          onClose();
        }}
      >
        <div className="eyebrow">THIS DEVICE</div>
        <h2>Settings</h2>
        <label htmlFor="writer-name">Your name on revisions</label>
        <input
          id="writer-name"
          maxLength={100}
          value={name}
          placeholder="Writer"
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
        <p>
          Recorded as the author of revisions in projects kept on this device.
          Cloud projects use your DraftBranch account name.
        </p>
        {info && (
          <>
            <p className="settings-label">Library location</p>
            <p className="settings-path">
              <code>{info.libraryPath}</code>
            </p>
            <p>
              Every project on this device lives in this folder, each with its
              full revision history as a Git repository. Back it up like any
              other folder.{" "}
              <button
                type="button"
                className="vc-link"
                onClick={() =>
                  void device({ kind: "library.reveal" }).catch(() => {})
                }
              >
                {isMac() ? "Show in Finder" : "Open folder"}
              </button>
            </p>
            <p className="settings-version">
              DraftBranch for desktop {info.version}
            </p>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-action">{saved ? "Saved" : "Save"}</button>
        </div>
      </form>
    </dialog>
  );
}
