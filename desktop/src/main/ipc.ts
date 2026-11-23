/** Answers the renderer's requests. Everything arriving here is untrusted
 * input: the sender must be the app's own page, and each handler validates
 * what it is given (the stores re-validate ids, names and snapshots). */
import { writeFile } from "node:fs/promises";
import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  app,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { InvalidInput } from "../core/snapshot";
import type { ProjectApi, ProjectRef } from "../core/types";
import {
  type AppInfo,
  INVOKE_CHANNEL,
  PROJECT_METHODS,
  type Reply,
  type Request,
} from "../shared/bridge";
import { cancelGoogleSignIn, googleSignIn } from "./google-auth";
import type { Library } from "./store/library";
import { StoreError } from "./store/project-store";

export interface IpcContext {
  library: Library;
  rendererDir: string;
  dev: boolean;
  /** True for URLs of the app's own pages. */
  isAppUrl(url: string): boolean;
  window(): BrowserWindow | null;
  /** The renderer has flushed its unsaved work; the window may close. */
  readyToClose(): void;
}

const isRef = (value: unknown): value is ProjectRef =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ProjectRef).scope === "string" &&
  typeof (value as ProjectRef).id === "string";

export function registerIpc(context: IpcContext) {
  ipcMain.handle(
    INVOKE_CHANNEL,
    async (event, request: Request): Promise<Reply<unknown>> => {
      try {
        if (!context.isAppUrl(senderUrl(event)))
          throw new StoreError("forbidden", "Request refused.");
        return { ok: true, value: await handle(context, request) };
      } catch (error) {
        const expected =
          error instanceof StoreError || error instanceof InvalidInput;
        if (!expected) console.error("[draftbranch]", error);
        return {
          ok: false,
          error: {
            message: expected
              ? (error as Error).message
              : "Something went wrong on this device. Please try again.",
            ...(error instanceof StoreError ? { code: error.code } : {}),
          },
        };
      }
    },
  );
}

function senderUrl(event: IpcMainInvokeEvent): string {
  try {
    return event.senderFrame?.url ?? "";
  } catch {
    return "";
  }
}

async function handle(context: IpcContext, request: Request): Promise<unknown> {
  const { library } = context;
  if (!request || typeof request !== "object")
    throw new StoreError("invalid", "Malformed request.");
  switch (request.kind) {
    case "app.info":
      return {
        version: app.getVersion(),
        platform: process.platform,
        libraryPath: library.root,
        dev: context.dev,
      } satisfies AppInfo;
    case "app.readyToClose":
      return context.readyToClose();
    case "settings.get":
      return library.settings();
    case "settings.set":
      return library.updateSettings(request.patch ?? {});
    case "library.list":
      return library.list(String(request.scope));
    case "library.summary":
      if (!isRef(request.ref))
        throw new StoreError("invalid", "Invalid project.");
      return library.summary(request.ref);
    case "library.createLocal":
      return library.createLocal(request.input ?? { title: "" });
    case "library.createClone":
      return library.createClone(request.input);
    case "library.remove":
      if (!isRef(request.ref))
        throw new StoreError("invalid", "Invalid project.");
      return library.remove(request.ref);
    case "library.reveal": {
      const problem = await shell.openPath(library.root);
      if (problem)
        throw new StoreError(
          "not-found",
          "The library folder could not be opened.",
        );
      return;
    }
    case "project.call": {
      if (!isRef(request.ref) || !PROJECT_METHODS.includes(request.method))
        throw new StoreError("invalid", "Unknown project request.");
      const store = await library.open(request.ref);
      const method = store[request.method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const args = Array.isArray(request.args) ? request.args : [];
      return method.apply(store as ProjectApi, args);
    }
    case "auth.google":
      return googleSignIn(context.rendererDir);
    case "auth.cancel":
      return cancelGoogleSignIn();
    case "shell.open": {
      // Links leave the app only for the web, never for local files or other schemes.
      let url: URL;
      try {
        url = new URL(String(request.url));
      } catch {
        throw new StoreError("invalid", "Invalid link.");
      }
      if (url.protocol !== "https:")
        throw new StoreError("invalid", "Invalid link.");
      await shell.openExternal(url.toString());
      return;
    }
    case "files.exportPdf":
      return exportPdf(context, String(request.name ?? "screenplay"));
    default:
      throw new StoreError("invalid", "Unknown request.");
  }
}

/** Print the current page to a PDF using the screenplay's own print styles
 * (US Letter, no browser headers or footers). */
async function exportPdf(context: IpcContext, name: string): Promise<boolean> {
  const window = context.window();
  if (!window) return false;
  const safe =
    name
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim()
      .slice(0, 80) || "screenplay";
  const choice = await dialog.showSaveDialog(window, {
    title: "Export screenplay as PDF",
    defaultPath: `${safe}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (choice.canceled || !choice.filePath) return false;
  const data = await window.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  await writeFile(choice.filePath, data);
  return true;
}
