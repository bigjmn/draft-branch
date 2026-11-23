import { useEffect } from "react";
import { device, onAppEvent } from "./platform/bridge";
import { OPEN_SYNC } from "./platform/events";
import { flushAll } from "./platform/flush";
import { navigate, useLocation } from "./router";
import { EditorRoute } from "./ui/editor-route";
import { Library } from "./ui/library";

/** The engine handles undo/redo and the editor handles save on key events, so a
 * menu command is delivered as the key press it stands for. */
function pressKey(key: string, shift = false) {
  const target = document.activeElement?.closest(".block") ?? window;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      metaKey: true,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}
function editCommand(command: "undo" | "redo") {
  // Screenplay elements have their own history; ordinary text fields use the browser's.
  if (document.activeElement?.closest(".block"))
    pressKey("z", command === "redo");
  else document.execCommand(command);
}

/** Printing and PDF export are for a screenplay, not for the library page. */
const inEditor = () => !!document.querySelector(".editor-shell");

export function App() {
  const { pathname } = useLocation();
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "before-close") {
          void flushAll().finally(() =>
            device({ kind: "app.readyToClose" }).catch(() => {}),
          );
          return;
        }
        switch (event.action) {
          case "new-project":
            return navigate("/?new=1");
          case "library":
            return navigate("/");
          case "save":
            return pressKey("s");
          case "undo":
          case "redo":
            return editCommand(event.action);
          case "print":
            return inEditor() ? window.print() : undefined;
          case "export-pdf": {
            if (!inEditor()) return;
            // A focused element would print its text caret into the PDF.
            const focused = document.activeElement as HTMLElement | null;
            focused?.blur();
            return void device({
              kind: "files.exportPdf",
              name: document.title.replace(/ — DraftBranch$/, ""),
            })
              .catch(() => {})
              .finally(() => focused?.focus());
          }
          case "sync":
            return void window.dispatchEvent(new Event(OPEN_SYNC));
        }
      }),
    [],
  );
  return pathname === "/editor" ? <EditorRoute /> : <Library />;
}
