/** The contract between the sandboxed renderer and the main process.
 * One request channel, one event channel; the main process validates every
 * request, so the renderer never touches the file system or Node directly. */
import type {
  DeviceSettings,
  ProjectApi,
  ProjectMeta,
  ProjectMethod,
  ProjectRef,
  ProjectSummary,
  Role,
} from "../core/types";

export const INVOKE_CHANNEL = "draftbranch:invoke";
export const EVENT_CHANNEL = "draftbranch:event";

export type Request =
  | { kind: "app.info" }
  | { kind: "app.readyToClose" }
  | { kind: "settings.get" }
  | { kind: "settings.set"; patch: Partial<Pick<DeviceSettings, "writerName">> }
  | { kind: "library.list"; scope: string }
  | { kind: "library.summary"; ref: ProjectRef }
  | {
      kind: "library.createLocal";
      input: { title: string; draft?: unknown; authorName?: string };
    }
  | {
      kind: "library.createClone";
      input: { uid: string; projectId: string; title: string; role: Role };
    }
  | { kind: "library.remove"; ref: ProjectRef }
  | { kind: "library.reveal" }
  | {
      kind: "project.call";
      ref: ProjectRef;
      method: ProjectMethod;
      args: unknown[];
    }
  | { kind: "auth.google" }
  | { kind: "auth.cancel" }
  | { kind: "shell.open"; url: string }
  | { kind: "files.exportPdf"; name: string };

export interface AppInfo {
  version: string;
  platform: string;
  /** Where the library lives, for people who want to back it up. */
  libraryPath: string;
  dev: boolean;
}
export interface GoogleTokens {
  idToken: string;
  accessToken?: string;
}
/** Result type of each request kind. */
export interface Responses {
  "app.info": AppInfo;
  "app.readyToClose": void;
  "settings.get": DeviceSettings;
  "settings.set": DeviceSettings;
  "library.list": ProjectSummary[];
  "library.summary": ProjectSummary;
  "library.createLocal": ProjectMeta;
  "library.createClone": ProjectMeta;
  "library.remove": void;
  "library.reveal": void;
  "project.call": unknown;
  "auth.google": GoogleTokens | null;
  "auth.cancel": void;
  "shell.open": void;
  "files.exportPdf": boolean;
}
export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

export type MenuAction =
  | "new-project"
  | "library"
  | "save"
  | "undo"
  | "redo"
  | "print"
  | "export-pdf"
  | "sync";
export type AppEvent =
  | { type: "menu"; action: MenuAction }
  /** The window is about to close: flush unsaved writing, then answer app.readyToClose. */
  | { type: "before-close" };

/** What the preload script puts on `window.draftbranchDesktop`. */
export interface PreloadBridge {
  invoke(request: Request): Promise<Reply<unknown>>;
  on(listener: (event: AppEvent) => void): () => void;
  platform: string;
}

export const PROJECT_METHODS: readonly ProjectMethod[] = [
  "state",
  "commits",
  "readSnapshot",
  "readBlob",
  "loadDraft",
  "saveDraft",
  "commit",
  "createBranch",
  "mergeCommit",
  "setMeta",
  "importCommits",
  "writeSnapshot",
  "createCommit",
  "updateRefs",
  "setDraft",
  "syncState",
  "setDraftSync",
] satisfies readonly (keyof ProjectApi)[];
