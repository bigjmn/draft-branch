/** "Continue with Google" for a desktop app.
 *
 * Google refuses sign-in inside embedded browser windows, so the sign-in runs
 * in the person's own browser instead. The app serves one small page on
 * http://localhost (already an authorized domain for Firebase Authentication),
 * that page runs the normal Firebase Google sign-in, and hands the resulting
 * Google credential back to this process over the same loopback connection.
 * The renderer then signs in with that credential.
 *
 * The listener binds to loopback only, accepts a single result guarded by a
 * random one-time state value, and shuts down as soon as it has it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { shell } from "electron";
import type { GoogleTokens } from "../shared/bridge";
import { resolveInside } from "./protocol";

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cancelActive: (() => void) | null = null;

export function cancelGoogleSignIn() {
  cancelActive?.();
}

/** Resolves with the Google credential, or null if cancelled or timed out. */
export async function googleSignIn(
  rendererDir: string,
): Promise<GoogleTokens | null> {
  cancelActive?.();
  const state = randomBytes(32).toString("hex");
  const servers: Server[] = [];
  let finish!: (value: GoogleTokens | null) => void;
  const result = new Promise<GoogleTokens | null>(
    (resolve) => (finish = resolve),
  );
  let port = 0;

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    // Only this machine's browser talking to this exact listener is accepted.
    const host = request.headers.host ?? "";
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (request.method === "POST" && url.pathname === "/complete") {
      const origin = request.headers.origin;
      if (origin !== `http://localhost:${port}`) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      let body: { state?: unknown; idToken?: unknown; accessToken?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const given = Buffer.from(
        typeof body.state === "string" ? body.state : "",
      );
      const expected = Buffer.from(state);
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected) ||
        typeof body.idToken !== "string" ||
        !body.idToken ||
        body.idToken.length > 8192
      ) {
        response.writeHead(403).end();
        return;
      }
      const tokens: GoogleTokens = {
        idToken: body.idToken,
        ...(typeof body.accessToken === "string" &&
        body.accessToken.length <= 8192
          ? { accessToken: body.accessToken }
          : {}),
      };
      // Answer the page before the listener is torn down.
      response.writeHead(204);
      response.end(() => finish(tokens));
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const path = url.pathname === "/" ? "/auth.html" : url.pathname;
    // The sign-in page and its script, nothing else from the app.
    const file =
      path === "/auth.html" || path.startsWith("/assets/")
        ? resolveInside(rendererDir, path)
        : null;
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(file);
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      response.end(data);
    } catch {
      response.writeHead(404).end();
    }
  }

  const listen = (server: Server, host: string, onPort: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(onPort, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  const close = () => {
    cancelActive = null;
    clearTimeout(timer);
    for (const server of servers) {
      server.close();
      setTimeout(() => server.closeAllConnections?.(), 1000).unref();
    }
  };
  const timer = setTimeout(() => finish(null), TIMEOUT_MS);
  cancelActive = () => finish(null);

  try {
    // "localhost" may resolve to IPv4 or IPv6 depending on the system and
    // browser, so listen on both loopback addresses with the same port.
    const v4 = createServer(handler);
    await listen(v4, "127.0.0.1", 0);
    servers.push(v4);
    port = (v4.address() as AddressInfo).port;
    const v6 = createServer(handler);
    await listen(v6, "::1", port).then(
      () => servers.push(v6),
      () => {}, // No IPv6 loopback, or the port is taken there: IPv4 is enough.
    );
    await shell.openExternal(`http://localhost:${port}/?state=${state}`);
    return await result;
  } finally {
    close();
  }
}
