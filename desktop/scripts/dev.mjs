// Development: Vite serves the renderer with hot reload; Electron restarts
// whenever the main or preload bundle changes.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { context } from "esbuild";
import { createServer } from "vite";
import { copyPdfWorker, desktop, nodeBundles } from "./shared.mjs";

await copyPdfWorker();
const server = await createServer({
  configFile: join(desktop, "vite.config.mts"),
});
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5183/";

const electron = createRequire(import.meta.url)("electron");
let child = null;
let stopping = false;
function start() {
  child = spawn(electron, ["."], {
    cwd: desktop,
    stdio: "inherit",
    env: { ...process.env, DRAFTBRANCH_DEV_URL: url },
  });
  child.on("exit", () => {
    // Closing the app window ends the dev session; a rebuild restarts it.
    if (!stopping && !restarting) void stop();
  });
}
let restarting = false;
function restart() {
  restarting = true;
  child.once("exit", () => {
    restarting = false;
    start();
  });
  child.kill();
}
// Start Electron once both bundles exist; after that, any rebuild restarts it.
const built = new Set();
let timer;
function onBuilt(name) {
  built.add(name);
  if (built.size < nodeBundles.length) return;
  clearTimeout(timer);
  timer = setTimeout(() => (child ? restart() : start()), 150);
}
const contexts = await Promise.all(
  nodeBundles.map((bundle) =>
    context({
      ...bundle,
      plugins: [
        {
          name: "restart-electron",
          setup(build) {
            build.onEnd((result) => {
              if (!result.errors.length) onBuilt(bundle.outfile);
            });
          },
        },
      ],
    }),
  ),
);
for (const ctx of contexts) await ctx.watch();

async function stop() {
  stopping = true;
  child?.kill();
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  await server.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
