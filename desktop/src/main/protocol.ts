/** Serves the built renderer from app://draftbranch/ with a strict content
 * security policy. A custom scheme keeps the app off the network stack: there
 * is no local web server for other programs to reach. */
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { protocol } from "electron";

export const APP_SCHEME = "app";
export const APP_HOST = "draftbranch";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

function contentSecurityPolicy(emulators: boolean): string {
  const local = emulators ? " http://127.0.0.1:* http://localhost:*" : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.googleusercontent.com",
    "font-src 'self' data:",
    // Firebase Auth, Firestore, Storage and the callable Cloud Functions.
    `connect-src 'self' https://*.googleapis.com https://*.cloudfunctions.net https://*.run.app${local}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a URL path inside `root`, or null if it tries to leave it. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = normalize(join(root, decoded));
  return file === root || file.startsWith(root + sep) ? file : null;
}

export function serveRenderer(
  rendererDir: string,
  options: { emulators: boolean },
) {
  const root = normalize(rendererDir);
  const csp = contentSecurityPolicy(options.emulators);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST || request.method !== "GET")
      return new Response("Not found", { status: 404 });
    let file = resolveInside(root, url.pathname);
    if (!file) return new Response("Forbidden", { status: 403 });
    // Routes such as /editor are handled in the page; only real assets have an extension.
    if (!(await isFile(file))) {
      if (extname(url.pathname))
        return new Response("Not found", { status: 404 });
      file = join(root, "index.html");
    }
    const type =
      TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const html = type.startsWith("text/html");
    return new Response(new Uint8Array(await readFile(file)), {
      headers: {
        "content-type": type,
        "x-content-type-options": "nosniff",
        ...(html
          ? { "content-security-policy": csp, "cache-control": "no-cache" }
          : {}),
      },
    });
  });
}
