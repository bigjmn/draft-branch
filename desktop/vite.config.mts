import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;
const shared = resolve(here, "..", "src");

/** The Firebase web API key is the same public identifier the web app is built
 * with. It is read from the environment or from the repo's .env files and is
 * never written into source control. */
function firebaseApiKey(): string {
  const fromEnv =
    process.env.DRAFTBRANCH_FIREBASE_API_KEY ??
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (fromEnv) return fromEnv;
  for (const file of [
    resolve(here, ".env"),
    resolve(here, "..", ".env.local"),
    resolve(here, "..", ".env"),
  ]) {
    try {
      const match =
        /^\s*(?:DRAFTBRANCH_FIREBASE_API_KEY|NEXT_PUBLIC_FIREBASE_API_KEY)\s*=\s*(.+?)\s*$/m.exec(
          readFileSync(file, "utf8"),
        );
      if (match) return match[1].replace(/^["']|["']$/g, "");
    } catch {
      /* Try the next file. */
    }
  }
  return "";
}
const emulators = process.env.DRAFTBRANCH_USE_FIREBASE_EMULATORS === "true";

export default defineConfig(({ command }) => {
  const apiKey = firebaseApiKey();
  if (!apiKey && !emulators && command === "build")
    console.warn(
      "\n[draftbranch] No Firebase API key found. Local projects will work; sign-in and sync will not.\n" +
        "             Set NEXT_PUBLIC_FIREBASE_API_KEY in ../.env.local (see ../.env.example).\n",
    );
  return {
    root: resolve(here, "src", "renderer"),
    base: "/",
    publicDir: resolve(here, "src", "renderer", "public"),
    plugins: [react()],
    css: { postcss: { plugins: [tailwind()] } },
    resolve: {
      alias: [
        // The shared editor and version-control UI import the web app's project
        // API. Here that import resolves to an implementation backed by the
        // on-device repository (see src/renderer/data/client.ts).
        {
          find: /^@\/lib\/projects\/client$/,
          replacement: resolve(here, "src/renderer/data/client.ts"),
        },
        {
          find: /^next\/link$/,
          replacement: resolve(here, "src/renderer/shims/next-link.tsx"),
        },
        {
          find: /^next\/navigation$/,
          replacement: resolve(here, "src/renderer/shims/next-navigation.ts"),
        },
        { find: /^@\//, replacement: shared + "/" },
      ],
    },
    define: {
      // Without a key the app still runs for projects kept on the device; a
      // placeholder keeps the Firebase SDK from refusing to start.
      __DRAFTBRANCH_CLOUD__: JSON.stringify(Boolean(apiKey) || emulators),
      "process.env.NEXT_PUBLIC_FIREBASE_API_KEY": JSON.stringify(
        apiKey || "not-configured",
      ),
      "process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS": JSON.stringify(
        emulators ? "true" : "false",
      ),
    },
    server: {
      port: 5183,
      strictPort: true,
      fs: { allow: [resolve(here, "..")] },
    },
    build: {
      outDir: resolve(here, "dist", "renderer"),
      emptyOutDir: true,
      target: "chrome130",
      sourcemap: false,
      // Loaded from disk, not over a network: one large bundle is fine.
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: {
          main: resolve(here, "src/renderer/index.html"),
          // The page the system browser opens for "Continue with Google".
          auth: resolve(here, "src/renderer/auth.html"),
        },
      },
    },
  };
});
