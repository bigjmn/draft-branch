/** Canonical screenplay snapshots and the validation rules that go with them.
 *
 * This mirrors functions/src/projects/model.ts on purpose. A revision's Git blob
 * is exactly `serializeSnapshot(snapshot)`, so as long as the two stay identical a
 * revision has the same object id on this device and in DraftBranch cloud.
 * tests/backend-parity.test.ts compares this file against the backend's own code.
 */
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_BLOCKS = 10000;
export const MAX_BLOCK_TEXT = 100000;
export const MAX_TITLE = 200;
export const MAX_MESSAGE = 2000;
export const ELEMENT_TYPES = [
  "scene",
  "action",
  "character",
  "dialogue",
  "parenthetical",
  "shot",
  "transition",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];
export interface SnapshotBlock {
  id: string;
  type: ElementType;
  text: string;
}
/** The cover page. Optional so older revisions keep their bytes. */
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
export interface Snapshot {
  schemaVersion: 1;
  title: string;
  blocks: SnapshotBlock[];
  titlePage?: TitlePage;
}

/** Bad input from the editor or from disk. The message is safe to show a writer. */
export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}
function fail(message: string): never {
  throw new InvalidInput(message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Expected an object.");
  return value as Record<string, unknown>;
}
const utf8Length = (value: string) => new TextEncoder().encode(value).length;

export function parseSnapshot(value: unknown): Snapshot {
  const input = record(value);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    fail("Unsupported screenplay schema version.");
  if (typeof input.title !== "string" || input.title.length > MAX_TITLE)
    fail("Invalid screenplay title.");
  if (
    !Array.isArray(input.blocks) ||
    input.blocks.length < 1 ||
    input.blocks.length > MAX_BLOCKS
  )
    fail("A screenplay needs between 1 and 10000 elements.");
  const ids = new Set<string>();
  const blocks = input.blocks.map((item: unknown) => {
    const block = record(item);
    if (
      typeof block.id !== "string" ||
      !block.id.trim() ||
      block.id.length > 128
    )
      fail("Invalid block id.");
    // The backend trims ids before checking them; do the same so both sides
    // canonicalize a snapshot to the same bytes.
    const id = block.id.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail("Invalid block id.");
    if (ids.has(id)) fail("Duplicate element id.");
    ids.add(id);
    if (
      !ELEMENT_TYPES.includes(block.type as ElementType) ||
      typeof block.text !== "string" ||
      block.text.length > MAX_BLOCK_TEXT
    )
      fail("Invalid screenplay element.");
    return { id, type: block.type as ElementType, text: block.text };
  });
  const snapshot: Snapshot = { schemaVersion: 1, title: input.title, blocks };
  if (input.titlePage !== undefined && input.titlePage !== null) {
    const page = record(input.titlePage);
    const field = (key: keyof TitlePage) => {
      const value = page[key];
      if (typeof value !== "string" || value.length > TITLE_PAGE_LIMITS[key])
        fail("Invalid title page.");
      return value;
    };
    snapshot.titlePage = {
      title: field("title"),
      credit: field("credit"),
      authors: field("authors"),
      contact: field("contact"),
    };
  }
  if (utf8Length(JSON.stringify(snapshot)) > MAX_DRAFT_BYTES)
    fail("Screenplay exceeds the 2 MiB limit.");
  return snapshot;
}

/** The exact text committed to Git as screenplay.json. */
export function serializeSnapshot(value: unknown): string {
  return JSON.stringify(parseSnapshot(value), null, 2) + "\n";
}
export function sameSnapshot(a: unknown, b: unknown): boolean {
  return serializeSnapshot(a) === serializeSnapshot(b);
}
export function blankSnapshot(title: string): Snapshot {
  return {
    schemaVersion: 1,
    title,
    blocks: [{ id: "initial-scene", type: "scene", text: "" }],
  };
}
/** Same as the backend: project title, "written by", the owner's name and
 * placeholder contact lines. Not renamed with the project later. */
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

export const isOid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
export const isProjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
/** Same rule as the backend, so every branch made offline can be published. */
export const isBranchName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`Invalid ${name}.`);
  return value.trim();
}
export const commitMessage = (value: unknown) =>
  text(value, "commit message", MAX_MESSAGE);
export const projectTitle = (value: unknown) =>
  text(value, "project title", MAX_TITLE);
export function branchName(value: unknown): string {
  if (!isBranchName(value))
    fail(
      "Use a lowercase branch name with letters, numbers, and single hyphens.",
    );
  return value;
}
export function oid(value: unknown): string {
  if (!isOid(value)) fail("Invalid commit id.");
  return value;
}
/** Name written into a commit: no characters that would break Git's author line. */
export function authorName(value: unknown, fallback = "Writer"): string {
  const name =
    typeof value === "string"
      ? value
          .replace(/[\n\r<>]/g, "")
          .trim()
          .slice(0, 100)
      : "";
  return name || fallback;
}
