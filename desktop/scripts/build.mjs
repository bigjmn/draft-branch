// Production build: renderer (Vite) + main and preload (esbuild) into dist/.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import { copyPdfWorker, desktop, emulators, nodeBundles } from "./shared.mjs";

await rm(join(desktop, "dist"), { recursive: true, force: true });
await copyPdfWorker();
await vite({ configFile: join(desktop, "vite.config.mts") });
for (const bundle of nodeBundles) await esbuild({ ...bundle, minify: false });
await mkdir(join(desktop, "dist"), { recursive: true });
await writeFile(
  join(desktop, "dist", "build-info.json"),
  JSON.stringify({ emulators }) + "\n",
);
console.log("\nBuilt DraftBranch desktop into dist/. Run it with `npm start`.");
