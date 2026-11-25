"use client";
import { ROLE_LABELS } from "@/lib/projects/permissions";
import { BetaBadge } from "@/components/ui/beta-badge";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import { DeleteProject } from "./delete-project";
import { FdxFileInput } from "@/components/editor/fdx-import";
import type { Draft } from "@/lib/editor/types";
import { initializeImportedProject } from "@/lib/projects/initialize-import";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useRedirect } from "@/components/auth/use-redirect";
import { debugLog, describeUser, watchSlow } from "@/lib/debug";
import { ThemeToggle } from "@/components/theme/theme-provider";
import { firebaseAuth } from "@/lib/firebase/client";
import {
  createProject,
  loadProjectDraft,
  saveProjectDraft,
  watchProjects,
  type Project,
} from "@/lib/projects/client";
import { projectHref } from "@/lib/projects/routes";
export function Dashboard() {
  const { user, loading } = useAuth();
  useEffect(() => {
    debugLog(
      "route",
      `dashboard: ${loading ? "waiting for sign-in state" : user && !user.isAnonymous ? "showing projects" : "leaving"}`,
      describeUser(user),
    );
  }, [loading, user]);
  useRedirect(
    loading || (user && !user.isAnonymous) ? null : user ? "/editor" : "/",
    user ? "guest opened the dashboard" : "signed out on the dashboard",
  );
  if (loading || !user || user.isAnonymous) return <TypewriterLoader />;
  return (
    <ProjectList
      key={user.uid}
      name={user.displayName || user.email || "Writer"}
    />
  );
}
function ProjectList({ name }: { name: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [imported, setImported] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<{ title: string; id: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const done = watchSlow("data", "dashboard: project list");
    return watchProjects(
      (list) => {
        done(`${list.length} projects`);
        setProjects(list);
      },
      (failure) => {
        done("failed");
        console.error("[data] dashboard: project list failed", failure);
        setError(
          "We couldn’t load your projects. Check your connection and try reloading.",
        );
      },
    );
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !title.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setCreateError("");
    const value = title.trim();
    if (request.current?.title !== JSON.stringify({ value, imported }))
      request.current = {
        title: JSON.stringify({ value, imported }),
        id: crypto.randomUUID(),
      };
    try {
      const project = await createProject(
        value,
        request.current!.id,
        imported ?? undefined,
      );
      if (imported) {
        const importedDraft = { ...imported, title: value };
        await initializeImportedProject(
          project.head,
          importedDraft,
          () => loadProjectDraft(project.projectId, "main"),
          (loaded) =>
            saveProjectDraft({
              projectId: project.projectId,
              branchId: "main",
              baseCommit: loaded.baseCommit,
              expectedVersion: loaded.version,
              draft: importedDraft,
              requestId: request.current!.id + "-import",
            }),
        );
      }
      router.push(projectHref(project.projectId));
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message +
              " Retry with the same title and file to avoid a duplicate."
          : "Couldn’t create the project. Please retry.",
      );
      setBusy(false);
      inFlight.current = false;
    }
  }
  const shown = (projects ?? []).filter(
    (p) =>
      (filter === "all" ||
        (filter === "owned" ? p.role === "owner" : p.role !== "owner")) &&
      p.title.toLowerCase().includes(query.toLowerCase()),
  );
  if (projects === null && !error) return <TypewriterLoader />;
  return (
    <div className="dashboard">
      <nav className="workspace-nav" aria-label="Workspace">
        <Link href="/dashboard" className="brand">
          <span className="brand-icon">d.</span> DraftBranch <BetaBadge />
        </Link>
        <div className="workspace-account">
          <ThemeToggle />
          <Link
            href="/profile"
            className="workspace-name"
            aria-label="Your profile"
          >
            {name}
          </Link>
          <button
            onClick={() =>
              signOut(firebaseAuth()).catch(() =>
                setError("Couldn’t sign out. Please try again."),
              )
            }
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <div className="eyebrow">YOUR WRITING ROOM</div>
            <h1>Let’s get to work.</h1>
            <p>Your projects, shared drafts, and next great idea.</p>
          </div>
          <button
            className="primary-action"
            onClick={() => dialog.current?.showModal()}
          >
            + New project
          </button>
        </div>
        <div className="project-tools">
          <div className="project-filters" aria-label="Filter projects">
            {[
              ["all", "All projects"],
              ["owned", "Owned by you"],
              ["shared", "Shared with you"],
            ].map(([id, label]) => (
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
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {error ? (
          <div role="alert" className="workspace-message">
            {error}
            <button onClick={() => window.location.reload()}>
              Reload projects
            </button>
          </div>
        ) : projects === null ? (
          <TypewriterLoader contained />
        ) : shown.length ? (
          <div className="project-grid">
            {shown.map((p) => (
              <div className="project-card-wrap" key={p.projectId}>
                <Link
                  className="project-card"
                  key={p.projectId}
                  href={projectHref(p.projectId)}
                >
                  <div className="project-card-top">
                    <span className="project-glyph" aria-hidden="true">
                      ▤
                    </span>
                    <span className="project-privacy">Private</span>
                  </div>
                  <h2>{p.title}</h2>
                  <p>
                    Screenplay ·{" "}
                    {p.role === "owner"
                      ? "Owned by you"
                      : `Shared with you · ${ROLE_LABELS[p.role] ?? p.role}`}
                  </p>
                  <div className="project-card-bottom">
                    <span>⑂ main</span>
                    <span>Open screenplay ↗</span>
                  </div>
                </Link>
                {p.role === "owner" && (
                  <DeleteProject projectId={p.projectId} title={p.title} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <section className="empty-projects">
            <span className="empty-mark" aria-hidden="true">
              ▤
            </span>
            <h2>
              {projects.length
                ? "No matching projects"
                : "A blank page. A world of possibility."}
            </h2>
            <p>
              {projects.length
                ? "Try another search or project filter."
                : "Create your first private project, or ask a collaborator to invite you to theirs."}
            </p>
            {!projects.length && (
              <button
                className="primary-action"
                onClick={() => dialog.current?.showModal()}
              >
                Create your first project
              </button>
            )}
          </section>
        )}
        <p className="workspace-footnote">
          A room for your stories. Projects are private and only visible to
          invited members.
        </p>
      </main>
      <dialog
        ref={dialog}
        className="create-project-dialog"
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <form onSubmit={create}>
          <div className="eyebrow">A NEW BEGINNING</div>
          <h2>Create a project</h2>
          <p>
            Start with a blank screenplay or import an FDX or PDF file. Only you
            can access it until you invite someone.
          </p>
          <label htmlFor="project-title">Project title</label>
          <input
            id="project-title"
            autoFocus
            required
            maxLength={200}
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled screenplay"
          />
          <FdxFileInput
            disabled={busy}
            onChange={(draft) => {
              setImported(draft);
              if (draft) setTitle(draft.title);
            }}
          />
          <p role="alert" className="form-error">
            {createError}
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button className="primary-action" disabled={busy || !title.trim()}>
              {busy ? "Creating…" : "Create project →"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
