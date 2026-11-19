"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ThemeToggle } from "@/components/theme/theme-provider";
import { firebaseAuth } from "@/lib/firebase/client";
import {
  createProject,
  watchProjects,
  type Project,
} from "@/lib/projects/client";
import { projectHref } from "@/lib/projects/routes";
export function Dashboard() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && (!user || user.isAnonymous))
      router.replace(user ? "/editor" : "/");
  }, [user, loading, router]);
  if (loading || !user || user.isAnonymous)
    return (
      <main className="loading-state" role="status">
        Opening your workspace…
      </main>
    );
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
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<{ title: string; id: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(
    () =>
      watchProjects(setProjects, () =>
        setError(
          "We couldn’t load your projects. Check your connection and try reloading.",
        ),
      ),
    [],
  );
  async function create(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !title.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setCreateError("");
    const value = title.trim();
    if (request.current?.title !== value)
      request.current = { title: value, id: crypto.randomUUID() };
    try {
      const project = await createProject(value, request.current!.id);
      router.push(projectHref(project.projectId));
    } catch {
      setCreateError(
        "Couldn’t create the project. Please try again. Your retry won’t create a duplicate.",
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
  return (
    <div className="dashboard">
      <nav className="workspace-nav" aria-label="Workspace">
        <Link href="/dashboard" className="brand">
          <span className="brand-icon">d.</span> DraftBranch
        </Link>
        <div className="workspace-account">
          <ThemeToggle />
          <span className="workspace-name">{name}</span>
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
            <h1>Good stories start here.</h1>
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
          <p role="status" className="workspace-message">
            Loading your projects…
          </p>
        ) : shown.length ? (
          <div className="project-grid">
            {shown.map((p) => (
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
                    : `Shared with you · ${p.role}`}
                </p>
                <div className="project-card-bottom">
                  <span>⑂ main</span>
                  <span>Open screenplay ↗</span>
                </div>
              </Link>
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
            Start with a blank screenplay. Only you can access it until you
            invite someone.
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
