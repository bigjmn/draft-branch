"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  downloadDraft,
  wordCount,
  type ExportFormat,
} from "@/lib/editor/draft";
import {
  ELEMENT_LABELS,
  type EditorLayout,
  type ElementType,
  type ScriptBlock,
} from "@/lib/editor/types";
import { ProjectComments } from "./project-comments";
import { FdxImportButton } from "./fdx-import";
import { EditorCanvas, type CanvasHandle } from "./editor-canvas";
import { EditorDialog, type DialogKind } from "./editor-dialog";
import { Sidebar, type EditorSection } from "./sidebar";
import { TitlePageView } from "./title-page-view";
import { titlePageOf, type TitlePageField } from "@/lib/editor/title-page";
import { Toolbar } from "./toolbar";
import { useDraft } from "./use-draft";
import { useProjectDraft, type EditorProject } from "./use-project-draft";
import { ThemeToggle } from "@/components/theme/theme-provider";
import Link from "next/link";
import { ShareProject } from "@/components/projects/share-project";
import { useAuth } from "@/components/auth/auth-provider";
import { AuthPanel } from "@/components/auth/auth-panel";
import {
  watchBranches,
  renameProject,
  type InvitationAccess,
  type Branch,
} from "@/lib/projects/client";
import { VersionControl, type VersionControlOptions } from "./version-control";
import { CommentMargin } from "./comment-margin";
import { commenterName, useBranchComments } from "@/lib/projects/comments";
import { canCommentOn, canModerateComments } from "@/lib/projects/permissions";

/** Lets another shell host the editor without forking it. The desktop app
 * (desktop/) passes this; the web app leaves it out and renders as before. */
export interface EditorHost {
  /** Replaces the link back to the dashboard. */
  home?: { href: string; label: string };
  /** Extra controls at the start of the header actions. */
  actions?: ReactNode;
  /** Sharing and comments need the cloud. Defaults to true. */
  collaboration?: boolean;
  versionControl?: VersionControlOptions;
  /** Where drafts are kept, for the help dialog. */
  storageNote?: string;
  /** Sidebar name and description when nobody is signed in. */
  guest?: { name: string; detail: string };
  /** Replaces the PRIVATE / LOCAL badge beside the branch name. */
  badge?: string;
}
export interface ReaderOptions {
  access?: InvitationAccess;
  branches?: Branch[];
  onBranchChange?: (branch: string) => void;
  onContribute?: () => void;
}
export function ReadOnlyEditor({
  project,
  reader = {},
  host,
}: {
  project: EditorProject;
  reader?: ReaderOptions;
  host?: EditorHost;
}) {
  const [branches, setBranches] = useState<Branch[]>([]);
  useEffect(() => {
    if (reader.access) return;
    return watchBranches(project.id, setBranches, () => setBranches([]));
  }, [project.id, reader.access]);
  const controls = {
    ...reader,
    branches: reader.branches ?? branches,
    onBranchChange:
      reader.onBranchChange ??
      ((name: string) =>
        window.location.assign(
          `/editor?project=${encodeURIComponent(project.id)}&branch=${encodeURIComponent(name)}`,
        )),
  };
  // Do not mount the autosave hook or restore private local drafts for readers.
  const state = {
    draft: project.initial.draft,
    status: "saved" as const,
    recoveryError: null,
    update: () => {},
    save: () => false,
  };
  return (
    <EditorView
      state={state}
      cloud
      project={project}
      readOnly
      reader={project.locked ? undefined : controls}
      host={host}
    />
  );
}
export function ScreenplayEditor({ project }: { project?: EditorProject }) {
  return project ? <CloudEditor project={project} /> : <LocalEditor />;
}
function LocalEditor() {
  const state = useDraft();
  return <EditorView state={state} />;
}
function CloudEditor({ project }: { project: EditorProject }) {
  const state = useProjectDraft(project);
  return (
    <EditorView
      state={state}
      cloud
      project={project}
      getVersion={state.getVersion}
      canPublish={state.canPublish}
    />
  );
}
export function EditorView({
  state,
  cloud = false,
  project,
  getVersion,
  canPublish,
  readOnly = false,
  reader,
  host,
}: {
  state: Pick<
    ReturnType<typeof useDraft>,
    "draft" | "status" | "recoveryError" | "update" | "save"
  >;
  readOnly?: boolean;
  reader?: ReaderOptions;
  cloud?: boolean;
  project?: EditorProject;
  getVersion?: () => number;
  canPublish?: () => boolean;
  host?: EditorHost;
}) {
  const { draft, status, recoveryError, update, save } = state;
  const collaboration = host?.collaboration !== false;
  const { user } = useAuth();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const commentHost = useRef<HTMLDivElement>(null);
  // Notes need a signed-in project member; invitation-link guests read only.
  const member = project?.member;
  const notes =
    collaboration &&
    !!project &&
    !!member &&
    !!user &&
    !user.isAnonymous &&
    !reader?.access;
  const branchInfo = project?.branchInfo ?? {
    name: project?.branch ?? "main",
    protected: (project?.branch ?? "main") === "main",
  };
  const notePermissions = notes
    ? {
        uid: user!.uid,
        authorName: commenterName(user!),
        canComment: canCommentOn(member, branchInfo),
        canModerate: canModerateComments(member),
      }
    : null;
  const branchNotes = useBranchComments(
    notes ? project!.id : undefined,
    project?.branch,
  );
  const openNotes = branchNotes.comments.filter((c) => !c.resolved).length;
  const [signup, setSignup] = useState(false);
  const signupDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (signup) signupDialog.current?.showModal();
  }, [signup]);
  const canvas = useRef<CanvasHandle>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [layout, setLayout] = useState<EditorLayout>({ pages: 1, scenes: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [type, setType] = useState<ElementType>("scene");
  const [zoom, setZoom] = useState("fit");
  const [focus, setFocus] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [importGeneration, setImportGeneration] = useState(0);
  const [titleError, setTitleError] = useState("");
  const [toast, setToast] = useState("");
  // Opening a project always starts on the screenplay.
  const [section, setSection] = useState<EditorSection>("screenplay");
  const [printTitle, setPrintTitle] = useState(false);
  const hydratedTitle = useRef(false);
  // Fills in the title page of a draft from before title pages existed. Only
  // the owner (or the writer of a local draft) is the presumed author.
  const defaultAuthor =
    project && project.role !== "owner"
      ? ""
      : user && !user.isAnonymous
        ? (user.displayName ?? "")
        : (host?.guest?.name ?? "");

  useEffect(() => {
    if (!draft) return;
    document.title = `${draft.title} — DraftBranch`;
    if (title.current && !hydratedTitle.current) {
      title.current.textContent = draft.title;
      hydratedTitle.current = true;
    }
  }, [draft]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (readOnly) return;
        setToast(
          save()
            ? cloud
              ? "Cloud save requested. Check the save status."
              : "Draft saved on this device."
            : "Unable to save. Export a copy to keep your work.",
        );
      }
      if (event.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save, cloud, readOnly]);

  const onSelection = useCallback((id: string, next: ElementType) => {
    setSelectedId(id);
    setType(next);
  }, []);
  const onBlocks = useCallback(
    (blocks: ScriptBlock[]) => {
      if (draft) update({ ...draft, blocks });
    },
    [draft, update],
  );
  useEffect(() => {
    if (!printTitle) return;
    const done = () => setPrintTitle(false);
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, [printTitle]);
  const onExport = (format: ExportFormat, includeTitlePage: boolean) => {
    if (draft)
      downloadDraft(draft, format, {
        titlePage: includeTitlePage,
        author: defaultAuthor,
      });
    setDialog(null);
    setToast("Your screenplay has been exported.");
  };
  const onPrint = (includeTitlePage: boolean) => {
    setDialog(null);
    setPrintTitle(includeTitlePage);
    canvas.current?.paginate();
    // Let React close the dialog before opening the browser print sheet.
    requestAnimationFrame(() => window.print());
  };
  const showSection = (next: EditorSection) => {
    if (next !== section)
      (document.activeElement as HTMLElement | null)?.blur?.();
    setSection(next);
  };
  if (!draft) return <TypewriterLoader />;
  const titlePage = titlePageOf(draft, defaultAuthor);
  const onTitlePage = (field: TitlePageField, value: string) =>
    update({ ...draft, titlePage: { ...titlePage, [field]: value } });
  const onTitle = section === "titlePage";

  return (
    <div
      className={`editor-shell${focus ? " focus" : ""}`}
      data-zoom={zoom}
      data-print-title={printTitle || undefined}
    >
      <Sidebar
        readOnly={readOnly}
        section={section}
        onSection={showSection}
        title={draft.title}
        scenes={layout.scenes}
        selectedId={selectedId}
        onScene={(id) => {
          showSection("screenplay");
          // Focus once the screenplay is showing again.
          requestAnimationFrame(() => canvas.current?.focus(id));
        }}
        onAdd={() => canvas.current?.append("scene")}
        onHelp={() => setDialog("help")}
        guest={host?.guest}
      />
      {commentsOpen && notes && (
        <ProjectComments
          branch={project!.branch}
          comments={branchNotes.comments}
          error={branchNotes.error}
          blocks={draft.blocks}
          onOpen={(id) => {
            showSection("screenplay");
            commentHost.current
              ?.querySelector(`.block[data-id="${CSS.escape(id)}"]`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
            setOpenNote(id);
          }}
          onClose={() => setCommentsOpen(false)}
        />
      )}
      <div id="app">
        <header>
          <div className="breadcrumb">
            {draft.title} <span>/</span>{" "}
            <strong>{onTitle ? "Title page" : "Screenplay"}</strong>
          </div>
          <div className="header-actions">
            {host?.home ? (
              <Link className="dashboard-back" href={host.home.href}>
                {host.home.label}
              </Link>
            ) : (
              cloud &&
              (user && !user.isAnonymous ? (
                <Link className="dashboard-back" href="/dashboard">
                  ← Dashboard
                </Link>
              ) : (
                <button
                  className="dashboard-back"
                  onClick={() => setSignup(true)}
                >
                  ← Dashboard
                </button>
              ))
            )}
            {host?.actions}
            {!readOnly && collaboration && project?.role === "owner" && (
              <ShareProject projectId={project.id} uid={project.uid} />
            )}
            <VersionControl
              project={project}
              readOnly={readOnly && !project?.locked}
              locked={!!project?.locked}
              reader={reader}
              draft={draft}
              saved={status === "saved"}
              getVersion={getVersion}
              canPublish={canPublish}
              options={host?.versionControl}
            />
            {notes && (
              <button
                className="button"
                aria-expanded={commentsOpen}
                onClick={() => setCommentsOpen((value) => !value)}
              >
                Comments{openNotes ? ` (${openNotes})` : ""}
              </button>
            )}
            <ThemeToggle />
            <span id="saveStatus" role="status">
              {!readOnly && status === "saved" && <i />}
              {readOnly
                ? "Read only"
                : status === "saving"
                  ? "Saving…"
                  : status === "error"
                    ? "Not saved — export a copy"
                    : cloud
                      ? "Saved to cloud"
                      : "Saved locally"}
            </span>
            {!readOnly && (
              <FdxImportButton
                onImport={(next) => {
                  // An FDX without a title page keeps the one you have.
                  update({
                    ...next,
                    ...(next.titlePage || !draft.titlePage
                      ? {}
                      : { titlePage: draft.titlePage }),
                  });
                  if (title.current) title.current.textContent = next.title;
                  setSelectedId(null);
                  setImportGeneration((value) => value + 1);
                  setToast("Screenplay imported into your working draft.");
                }}
              />
            )}
            <button className="button" onClick={() => setDialog("export")}>
              Export <span>↗</span>
            </button>
          </div>
        </header>
        <section className="document-header">
          <div>
            <div className="eyebrow">
              {readOnly ? "COMMITTED DRAFT" : "WORKING DRAFT"}
            </div>
            <h1
              ref={title}
              contentEditable={!readOnly}
              suppressContentEditableWarning
              spellCheck={false}
              aria-label="Screenplay title"
              onInput={(event) =>
                !readOnly &&
                update({
                  ...draft,
                  title: event.currentTarget.textContent ?? "",
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                if (readOnly) return;
                const text =
                  event.currentTarget.textContent?.trim().slice(0, 200) ||
                  "Untitled screenplay";
                event.currentTarget.textContent = text;
                update({ ...draft, title: text });
                if (project?.role === "owner") {
                  setTitleError("");
                  void renameProject(project.id, text).catch(() =>
                    setTitleError(
                      "The screenplay title was changed, but the project name could not be saved. Check your connection and try editing the title again.",
                    ),
                  );
                }
              }}
            />
            <p>A little space for your next great story.</p>
          </div>
          <div className="draft-label">
            <span className="branch-symbol">⑂</span>{" "}
            {readOnly && reader?.branches?.length ? (
              <select
                aria-label="Current branch"
                className="reader-branch-select"
                value={project?.branch}
                onChange={(event) =>
                  reader.onBranchChange?.(event.target.value)
                }
              >
                {reader.branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            ) : (
              project?.branch || "Main draft"
            )}{" "}
            <span className="local-badge">
              {host?.badge ?? (cloud ? "PRIVATE" : "LOCAL")}
            </span>
          </div>
        </section>
        {titleError && (
          <p className="recovery-banner" role="alert">
            {titleError}
          </p>
        )}
        <Toolbar
          readOnly={readOnly || onTitle}
          type={type}
          zoom={zoom}
          focus={focus}
          onType={(next) => canvas.current?.setType(next)}
          onZoom={setZoom}
          onFocus={() => setFocus((value) => !value)}
        />
        {recoveryError && (
          <p className="recovery-banner" role="alert">
            {recoveryError}
          </p>
        )}
        <main id="canvas">
          <div className="paper-caption">
            <span>{onTitle ? "TITLE PAGE" : "SCREENPLAY"}</span>
            <span>US LETTER · 8.5 × 11 IN</span>
          </div>
          {onTitle && (
            <div className="title-page-sheet">
              <TitlePageView
                page={titlePage}
                readOnly={readOnly}
                onChange={onTitlePage}
              />
            </div>
          )}
          <TitlePageView page={titlePage} printOnly />
          <div
            className={`comment-canvas${onTitle ? " screenplay-away" : ""}`}
            ref={commentHost}
            aria-hidden={onTitle || undefined}
          >
            <EditorCanvas
              key={importGeneration}
              readOnly={readOnly}
              ref={canvas}
              initialBlocks={draft.blocks}
              onChange={onBlocks}
              onSelection={onSelection}
              onLayout={setLayout}
            />
            {notePermissions && (
              <CommentMargin
                host={commentHost}
                projectId={project!.id}
                branch={project!.branch}
                comments={branchNotes.comments}
                permissions={notePermissions}
                open={openNote}
                onOpen={setOpenNote}
                layoutKey={`${layout.pages}:${zoom}:${importGeneration}:${section}`}
              />
            )}
          </div>
          {!readOnly && !onTitle && (
            <button
              className="add-block"
              onClick={() => canvas.current?.append("action")}
            >
              + Add a new element
            </button>
          )}
          {!onTitle && (
            <div className="paper-note">
              A place for the story. Everything else can wait.
            </div>
          )}
        </main>
        <footer>
          <span>
            <i />
            {layout.pages} {layout.pages === 1 ? "page" : "pages"} ·{" "}
            {wordCount(draft)} words
          </span>
          <span>{onTitle ? "Title page" : ELEMENT_LABELS[type]}</span>
          <span>
            {project?.locked ? (
              "You can’t edit this branch · Branch from it to make changes"
            ) : readOnly ? (
              "Read-only access · All branches"
            ) : (
              <>
                <kbd>Tab</kbd> Change element <b>·</b> <kbd>Enter</kbd> Next
                element
              </>
            )}
          </span>
        </footer>
      </div>
      {signup && (
        <dialog
          ref={signupDialog}
          className="reader-signup"
          onCancel={() => setSignup(false)}
        >
          <button
            className="reader-signup-close"
            aria-label="Close sign up"
            onClick={() => setSignup(false)}
          >
            ×
          </button>
          <h2>Sign up to manage projects</h2>
          <p>
            Create an account to keep projects in your dashboard and start your
            own screenplays.
          </p>
          {user && !user.isAnonymous ? (
            <Link className="primary-action" href="/dashboard">
              Go to dashboard
            </Link>
          ) : (
            <AuthPanel />
          )}
        </dialog>
      )}
      {readOnly && reader?.onContribute && (
        <button className="reader-contribute" onClick={reader.onContribute}>
          Invitation & account options
        </button>
      )}
      <EditorDialog
        kind={dialog}
        onClose={() => setDialog(null)}
        onExport={onExport}
        onPrint={onPrint}
        storageNote={host?.storageNote}
      />
      <div id="toast" className={toast ? "visible" : ""} role="status">
        {toast}
      </div>
    </div>
  );
}
