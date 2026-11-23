/** Runs in the sandboxed page before any app code. Exposes one narrow,
 * message-passing bridge; no Node or Electron objects reach the page. */
import { contextBridge, ipcRenderer } from "electron";
import {
  type AppEvent,
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type PreloadBridge,
  type Request,
} from "../shared/bridge";

const bridge: PreloadBridge = {
  invoke: (request: Request) => ipcRenderer.invoke(INVOKE_CHANNEL, request),
  on(listener) {
    const handler = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
  platform: process.platform,
};
contextBridge.exposeInMainWorld("draftbranchDesktop", bridge);
