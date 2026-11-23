/** DraftBranch desktop: main process. Owns the window, the project library on
 * disk, and the bridge the sandboxed page talks to. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, session, shell } from "electron";
import { type AppEvent, EVENT_CHANNEL } from "../shared/bridge";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  registerAppScheme,
  serveRenderer,
} from "./protocol";
import { Library } from "./store/library";

const devUrl = process.env.DRAFTBRANCH_DEV_URL;
const dev = !!devUrl;
const rendererDir = join(__dirname, "..", "renderer");
const preload = join(__dirname, "..", "preload", "index.cjs");
const iconDir = join(__dirname, "..", "..", "build");

app.setName("DraftBranch");
// Tests and side-by-side installs can point the app at another data folder.
if (process.env.DRAFTBRANCH_USER_DATA)
  app.setPath("userData", process.env.DRAFTBRANCH_USER_DATA);
else if (dev)
  app.setPath(
    "userData",
    join(app.getPath("appData"), "DraftBranch (development)"),
  );

registerAppScheme();

let mainWindow: BrowserWindow | null = null;
let closing = false;
let quitting = false;
let closeTimer: NodeJS.Timeout | undefined;

const isAppUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (devUrl) return url.origin === new URL(devUrl).origin;
    // URL.origin is "null" for a custom scheme, so compare its parts.
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
};
function buildInfo(): { emulators: boolean } {
  try {
    return JSON.parse(
      readFileSync(join(__dirname, "..", "build-info.json"), "utf8"),
    );
  } catch {
    return { emulators: false };
  }
}
const send = (event: AppEvent) =>
  mainWindow?.webContents.send(EVENT_CHANNEL, event);

function createWindow() {
  closing = false;
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: "DraftBranch",
    backgroundColor: "#111111",
    // Linux takes the taskbar icon from the window, not from the app's files.
    ...(process.platform === "linux"
      ? { icon: join(iconDir, "icons", "256x256.png") }
      : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  // Links open in the person's browser; the app window only shows the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
  // A page asking "leave site?" would silently block closing in Electron.
  // Unsaved writing is flushed through the before-close handshake instead.
  window.webContents.on("will-prevent-unload", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    send({ type: "before-close" });
    // If the page cannot answer, do not trap the person in the app.
    closeTimer ??= setTimeout(finishClose, 5000);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/`);
}
function finishClose() {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  closing = true;
  mainWindow?.close();
  // Quitting was paused while the page saved; carry on with it.
  if (quitting) app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(() => {
    if (!dev) {
      if (!existsSync(join(rendererDir, "index.html")))
        throw new Error(
          "The app has not been built. Run `npm run build` in desktop/.",
        );
      serveRenderer(rendererDir, buildInfo());
    }
    // `npm run dev` runs inside Electron's own app, so the Dock would show
    // Electron's icon. An installed copy carries the icon itself.
    const dockIcon = join(iconDir, "icon.png");
    if (dev && process.platform === "darwin" && existsSync(dockIcon))
      app.dock?.setIcon(dockIcon);
    // The app needs no camera, microphone, location or notifications.
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    const library = new Library(join(app.getPath("userData"), "library"));
    registerIpc({
      library,
      rendererDir,
      dev,
      isAppUrl,
      window: () => mainWindow,
      readyToClose: finishClose,
    });
    buildMenu({
      dev,
      send: (action) => send({ type: "menu", action }),
      window: () => mainWindow,
      libraryPath: library.root,
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
