import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const desktop = fileURLToPath(new URL("../", import.meta.url));
export const emulators =
  process.env.DRAFTBRANCH_USE_FIREBASE_EMULATORS === "true";

/** PDF import runs PDF.js in a worker; ship the worker that matches the installed version. */
export async function copyPdfWorker() {
  const target = new URL("../src/renderer/public/pdfjs/", import.meta.url);
  await mkdir(target, { recursive: true });
  await copyFile(
    new URL(
      "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ),
    new URL("pdf.worker.min.mjs", target),
  );
}

/** esbuild options for the two Node-side bundles. Electron is provided at run time. */
export const nodeBundles = [
  { entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs" },
  { entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs" },
].map((bundle) => ({
  ...bundle,
  absWorkingDir: desktop,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
}));
