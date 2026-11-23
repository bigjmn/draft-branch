/** The three Git object kinds a DraftBranch repository uses, in Git's own
 * byte format: a blob holding screenplay.json, a tree with that one file, and a
 * commit. Objects written here can be read by any Git client, and they hash to
 * the same ids as the ones the backend writes (see tests/backend-parity.test.ts).
 */
import { createHash } from "node:crypto";

export type GitObjectType = "blob" | "tree" | "commit";
export const SCREENPLAY_FILE = "screenplay.json";
export const AUTHOR_DOMAIN = "users.draftbranch.invalid";

export function wrap(type: GitObjectType, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
}
export function oidOf(type: GitObjectType, content: Buffer): string {
  return createHash("sha1").update(wrap(type, content)).digest("hex");
}

export function encodeTree(blob: string): Buffer {
  return Buffer.concat([
    Buffer.from(`100644 ${SCREENPLAY_FILE}\0`),
    Buffer.from(blob, "hex"),
  ]);
}
/** Returns the blob id of screenplay.json. */
export function decodeTree(content: Buffer): string {
  let cursor = 0;
  while (cursor < content.length) {
    const space = content.indexOf(32, cursor);
    const nul = content.indexOf(0, space);
    if (space === -1 || nul === -1 || nul + 21 > content.length)
      throw new Error("Malformed Git tree.");
    const path = content.subarray(space + 1, nul).toString("utf8");
    const id = content.subarray(nul + 1, nul + 21).toString("hex");
    if (path === SCREENPLAY_FILE) return id;
    cursor = nul + 21;
  }
  throw new Error("This revision has no screenplay.json.");
}

export interface CommitFields {
  tree: string;
  parent: string[];
  author: { name: string; email: string; timestamp: number };
  /** Without Git's trailing newline. */
  message: string;
}
/** Git's own normalization: no carriage returns, no leading blank lines, exactly
 * one trailing newline. */
function normalizeMessage(message: string): string {
  return (
    message.replace(/\r/g, "").replace(/^\n+/, "").replace(/\n+$/, "") + "\n"
  );
}
export function encodeCommit(fields: CommitFields): Buffer {
  const who = `${fields.author.name} <${fields.author.email}> ${fields.author.timestamp} +0000`;
  return Buffer.from(
    `tree ${fields.tree}\n` +
      fields.parent.map((p) => `parent ${p}\n`).join("") +
      `author ${who}\n` +
      `committer ${who}\n` +
      "\n" +
      normalizeMessage(fields.message),
    "utf8",
  );
}
export function decodeCommit(content: Buffer): CommitFields {
  const text = content.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = "";
  const parent: string[] = [];
  let author: CommitFields["author"] | undefined;
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parent.push(line.slice(7));
    else if (line.startsWith("author ")) {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.slice(7));
      if (match)
        author = {
          name: match[1],
          email: match[2],
          timestamp: Number(match[3]),
        };
    }
  }
  if (!/^[0-9a-f]{40}$/.test(tree) || !author)
    throw new Error("Malformed Git commit.");
  return { tree, parent, author, message: message.replace(/\n+$/, "") };
}

/** Commit email for a signed-in account: a hash, never the account's address.
 * The backend derives the same value from the uid. */
export function accountAuthorKey(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 24);
}
export const authorEmail = (key: string) => `${key}@${AUTHOR_DOMAIN}`;
export const authorKeyOf = (email: string) =>
  email.endsWith(`@${AUTHOR_DOMAIN}`)
    ? email.slice(0, -AUTHOR_DOMAIN.length - 1)
    : email;
