import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import {
  type BranchAccessInfo,
  type MemberAccess,
  type Role,
  canBranchFrom,
  canEditBranch,
  canMergeInto,
} from "./permissions";
export type { Role } from "./permissions";

export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const ELEMENT_TYPES = [
  "scene",
  "action",
  "character",
  "dialogue",
  "parenthetical",
  "shot",
  "transition",
] as const;
export interface Actor {
  uid: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
}
/** The cover page: title, credit line, author(s) and a contact block.
 * Optional so revisions made before title pages existed keep their bytes. */
export interface TitlePage {
  title: string;
  credit: string;
  authors: string;
  contact: string;
}
export const TITLE_PAGE_LIMITS = {
  title: 500,
  credit: 200,
  authors: 1000,
  contact: 2000,
} as const;
export interface Draft {
  title: string;
  blocks: { id: string; type: (typeof ELEMENT_TYPES)[number]; text: string }[];
  titlePage?: TitlePage;
}
export interface Snapshot extends Draft {
  schemaVersion: 1;
}
export interface Branch extends BranchAccessInfo {
  name: string;
  head: string;
  protected: boolean;
}
export interface CommitJob {
  actor: Actor;
  branchId: string;
  expectedHead: string;
  snapshotPath: string;
  message: string;
  timestamp: number;
  fingerprint: string;
  status: "queued" | "succeeded" | "conflict" | "rejected";
}
export function fail(
  code: ConstructorParameters<typeof HttpsError>[0],
  message: string,
): never {
  throw new HttpsError(code, message);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-argument", "Expected an object.");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("invalid-argument", `Invalid ${name}.`);
  return value.trim();
}
export function id(value: unknown, name = "id"): string {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result))
    fail("invalid-argument", `Invalid ${name}.`);
  return result;
}
export function branchId(value: unknown): string {
  const name = text(value, "branch name", 64);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
    fail(
      "invalid-argument",
      "Use a lowercase branch name with letters, numbers, and single hyphens.",
    );
  return name;
}
export function oid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    fail("invalid-argument", "Invalid commit id.");
  return value;
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("invalid-argument", "Invalid draft version.");
  return value as number;
}
export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function requestKey(actor: Actor, requestId: unknown): string {
  return hash(`${actor.uid}:${id(requestId, "requestId")}`);
}
export function assertRole(role: unknown, allowed: Role[]): void {
  if (!allowed.includes(role as Role))
    fail("permission-denied", "Project access is not permitted.");
}
/** Saving and committing on a branch. See permissions.ts for the rules. */
export function assertPublish(
  member: MemberAccess | undefined,
  uid: string,
  branch: BranchAccessInfo,
): void {
  if (!canEditBranch(member, uid, branch))
    fail(
      "permission-denied",
      branch.protected
        ? `You can’t edit ${branch.name}. Create a branch from it to make changes.`
        : `You can’t edit the branch ${branch.name}.`,
    );
}
/** Merging changes the target, so it takes edit access to the target branch.
 * Everyone else opens a merge request for someone who can. */
export function assertMergeInto(
  member: MemberAccess | undefined,
  uid: string,
  branch: BranchAccessInfo,
): void {
  if (!canMergeInto(member, uid, branch))
    fail(
      "permission-denied",
      branch.protected
        ? `Only the owner, or an editor allowed to edit ${branch.name}, can merge into it. Open a merge request instead.`
        : `You can’t merge into ${branch.name}. Open a merge request instead.`,
    );
}
export function assertBranchFrom(
  member: MemberAccess | undefined,
  uid: string,
  branch: BranchAccessInfo,
): void {
  if (!canBranchFrom(member, uid, branch))
    fail(
      "permission-denied",
      "You can create branches only from your own dedicated branch or branches you made.",
    );
}
/** Name shown as a commit author: profile name, else the email's local part. */
export function authorName(actor: Actor): string {
  const name = actor.name
    .replace(/[\n\r<>]/g, "")
    .trim()
    .slice(0, 100);
  if (name && name !== "Writer") return name;
  return actor.email?.split("@")[0]?.slice(0, 100) || "Writer";
}
export function parseSnapshot(value: unknown): Snapshot {
  const input = record(value);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    fail("invalid-argument", "Unsupported screenplay schema version.");
  if (typeof input.title !== "string" || input.title.length > 200)
    fail("invalid-argument", "Invalid screenplay title.");
  if (
    !Array.isArray(input.blocks) ||
    input.blocks.length < 1 ||
    input.blocks.length > 10000
  )
    fail(
      "invalid-argument",
      "A screenplay needs between 1 and 10000 elements.",
    );
  const ids = new Set<string>();
  const blocks = input.blocks.map((item: unknown) => {
    const block = record(item);
    const blockId = id(block.id, "block id");
    if (ids.has(blockId)) fail("invalid-argument", "Duplicate element id.");
    ids.add(blockId);
    if (
      !ELEMENT_TYPES.includes(block.type as (typeof ELEMENT_TYPES)[number]) ||
      typeof block.text !== "string" ||
      block.text.length > 100000
    )
      fail("invalid-argument", "Invalid screenplay element.");
    return {
      id: blockId,
      type: block.type as (typeof ELEMENT_TYPES)[number],
      text: block.text,
    };
  });
  const snapshot: Snapshot = { schemaVersion: 1, title: input.title, blocks };
  if (input.titlePage !== undefined && input.titlePage !== null) {
    const page = record(input.titlePage);
    const field = (key: keyof TitlePage) => {
      const value = page[key];
      if (typeof value !== "string" || value.length > TITLE_PAGE_LIMITS[key])
        fail("invalid-argument", "Invalid title page.");
      return value;
    };
    snapshot.titlePage = {
      title: field("title"),
      credit: field("credit"),
      authors: field("authors"),
      contact: field("contact"),
    };
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_DRAFT_BYTES)
    fail("invalid-argument", "Screenplay exceeds the 2 MiB limit.");
  return snapshot;
}
export function serializeSnapshot(value: unknown): string {
  return JSON.stringify(parseSnapshot(value), null, 2) + "\n";
}
export function blankSnapshot(title: string): Snapshot {
  return {
    schemaVersion: 1,
    title,
    blocks: [{ id: "initial-scene", type: "scene", text: "" }],
  };
}
/** A new project's title page: the project title, "written by", the owner's
 * name and placeholder contact lines. It isn't renamed with the project later. */
export function defaultTitlePage(title: string, author: string): TitlePage {
  const name = title.trim();
  return {
    title: (!name || /^untitled( screenplay)?$/i.test(name) ? "Untitled" : name)
      .toUpperCase()
      .slice(0, TITLE_PAGE_LIMITS.title),
    credit: "written by",
    authors: author
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, TITLE_PAGE_LIMITS.authors),
    contact: "Company\nAddress\nPhone\nEmail",
  };
}
/** A new project's first revision. An imported draft keeps its own title page. */
export function newProjectSnapshot(
  title: string,
  author: string,
  draft?: unknown,
): Snapshot {
  const snapshot =
    draft === undefined
      ? blankSnapshot(title)
      : parseSnapshot({ ...record(draft), title });
  return snapshot.titlePage
    ? snapshot
    : { ...snapshot, titlePage: defaultTitlePage(title, author) };
}
export function assertRequest(
  existing: { fingerprint?: string } | undefined,
  fingerprint: string,
): void {
  if (existing && existing.fingerprint !== fingerprint)
    fail("already-exists", "This requestId was used for different input.");
}
