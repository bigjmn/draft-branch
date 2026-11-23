/** The application menu. Items that belong to the editor are forwarded to the
 * page as events, so one code path serves the menu, the keyboard and the buttons. */
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  app,
  shell,
} from "electron";
import type { MenuAction } from "../shared/bridge";

export function buildMenu(options: {
  dev: boolean;
  send(action: MenuAction): void;
  window(): BrowserWindow | null;
  libraryPath: string;
}) {
  const mac = process.platform === "darwin";
  const forward = (
    label: string,
    action: MenuAction,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => options.send(action),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        forward("New Project…", "new-project", "CmdOrCtrl+N"),
        forward("Library", "library", "CmdOrCtrl+Shift+L"),
        { type: "separator" },
        forward("Save", "save", "CmdOrCtrl+S"),
        forward("Sync with DraftBranch Cloud", "sync", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        forward("Export as PDF…", "export-pdf", "CmdOrCtrl+Shift+E"),
        forward("Print…", "print", "CmdOrCtrl+P"),
        { type: "separator" },
        {
          label: mac ? "Show Library in Finder" : "Show Library Folder",
          click: () => void shell.openPath(options.libraryPath),
        },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // The screenplay engine keeps its own undo history (structural edits
        // are not in the browser's), so these go to the page rather than
        // using the built-in undo role.
        forward("Undo", "undo", "CmdOrCtrl+Z"),
        forward("Redo", "redo", mac ? "Shift+Cmd+Z" : "Ctrl+Y"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(options.dev
          ? [
              { type: "separator" as const },
              { role: "reload" as const },
              { role: "toggleDevTools" as const },
            ]
          : []),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
