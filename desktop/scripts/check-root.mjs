// The desktop app shares the web app's source (../src) and its runtime
// libraries (React, Firebase, PDF.js, Tailwind), which live in the repository
// root's node_modules. One copy of each keeps the two apps on identical versions.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const missing = [
  "react",
  "react-dom",
  "react-markdown",
  "firebase",
  "pdfjs-dist",
  "@tailwindcss/postcss",
].filter(
  (name) => !existsSync(new URL(`node_modules/${name}/package.json`, root)),
);
if (missing.length) {
  console.error(
    `\nDraftBranch desktop needs the web app's dependencies (${missing.join(", ")}).\n` +
      `Install them first:\n\n  cd ${fileURLToPath(root)}\n  npm ci\n`,
  );
  process.exit(1);
}
