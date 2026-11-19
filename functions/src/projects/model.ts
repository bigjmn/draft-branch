import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";

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
export type Role = "owner" | "editor" | "reviewer";
export interface Actor {
  uid: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
}
export interface Draft {
  title: string;
  blocks: { id: string; type: (typeof ELEMENT_TYPES)[number]; text: string }[];
}
export interface Snapshot extends Draft {
  schemaVersion: 1;
}
export interface Branch {
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
export function assertPublish(role: unknown, branch: Branch): void {
  assertRole(role, branch.protected ? ["owner"] : ["owner", "editor"]);
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
export function assertRequest(
  existing: { fingerprint?: string } | undefined,
  fingerprint: string,
): void {
  if (existing && existing.fingerprint !== fingerprint)
    fail("already-exists", "This requestId was used for different input.");
}
