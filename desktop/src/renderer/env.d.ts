/// <reference types="vite/client" />
import type { PreloadBridge } from "../shared/bridge";

declare global {
  interface Window {
    /** Provided by the Electron preload script. */
    draftbranchDesktop?: PreloadBridge;
  }
}
declare module "*.md?raw" {
  const text: string;
  export default text;
}
export {};
declare global {
  /** Set at build time: whether this build can reach DraftBranch cloud. */
  const __DRAFTBRANCH_CLOUD__: boolean;
}
