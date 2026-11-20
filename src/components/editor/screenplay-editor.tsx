"use client";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { EditorCanvas, type CanvasHandle } from "./editor-canvas";
import { EditorDialog, type DialogKind } from "./editor-dialog";
import { Sidebar } from "./sidebar";
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
  type InvitationAccess,
  type Branch,
} from "@/lib/projects/client";
import { VersionControl } from "./version-control";

export interface ReaderOptions {
  access?: InvitationAccess;
  branches?: Branch[];
  onBranchChange?: (branch: string) => void;
  onContribute?: () => void;
}
export function ReadOnlyEditor({
  project,
  reader = {},
}: {
  project: EditorProject;
  reader?: ReaderOptions;
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
      reader={controls}
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
function EditorView({
  state,
  cloud = false,
  project,
  getVersion,
  canPublish,
  readOnly = false,
  reader,
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
}) {
  const { draft, status, recoveryError, update, save } = state;
  const { user } = useAuth();
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
  const [toast, setToast] = useState("");
  const hydratedTitle = useRef(false);

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
  const onExport = (format: ExportFormat) => {
    if (draft) downloadDraft(draft, format);
    setDialog(null);
    setToast("Your screenplay has been exported.");
  };
  const onPrint = () => {
    setDialog(null);
    canvas.current?.paginate();
    // Let React close the dialog before opening the browser print sheet.
    requestAnimationFrame(() => window.print());
  };
  if (!draft) return <TypewriterLoader />;

  return (
    <div className={`editor-shell${focus ? " focus" : ""}`} data-zoom={zoom}>
      <Sidebar
        readOnly={readOnly}
        title={draft.title}
        scenes={layout.scenes}
        selectedId={selectedId}
        onScene={(id) => canvas.current?.focus(id)}
        onAdd={() => canvas.current?.append("scene")}
        onHelp={() => setDialog("help")}
      />
      <div id="app">
        <header>
          <div className="breadcrumb">
            {draft.title} <span>/</span> <strong>Screenplay</strong>
          </div>
          <div className="header-actions">
            {cloud &&
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
              ))}
            {!readOnly && project?.role === "owner" && (
              <ShareProject projectId={project.id} uid={project.uid} />
            )}
            <VersionControl
              project={project}
              readOnly={readOnly}
              reader={reader}
              draft={draft}
              saved={status === "saved"}
              getVersion={getVersion}
              canPublish={canPublish}
            />
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
                  event.currentTarget.textContent?.trim() ||
                  "Untitled screenplay";
                event.currentTarget.textContent = text;
                update({ ...draft, title: text });
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
            <span className="local-badge">{cloud ? "PRIVATE" : "LOCAL"}</span>
          </div>
        </section>
        <Toolbar
          readOnly={readOnly}
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
            <span>SCREENPLAY</span>
            <span>US LETTER · 8.5 × 11 IN</span>
          </div>
          <EditorCanvas
            readOnly={readOnly}
            ref={canvas}
            initialBlocks={draft.blocks}
            onChange={onBlocks}
            onSelection={onSelection}
            onLayout={setLayout}
          />
          {!readOnly && (
            <button
              className="add-block"
              onClick={() => canvas.current?.append("action")}
            >
              + Add a new element
            </button>
          )}
          <div className="paper-note">
            A place for the story. Everything else can wait.
          </div>
        </main>
        <footer>
          <span>
            <i />
            {layout.pages} {layout.pages === 1 ? "page" : "pages"} ·{" "}
            {wordCount(draft)} words
          </span>
          <span>{ELEMENT_LABELS[type]}</span>
          <span>
            {readOnly ? (
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
      />
      <div id="toast" className={toast ? "visible" : ""} role="status">
        {toast}
      </div>
    </div>
  );
}
