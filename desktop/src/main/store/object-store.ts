/** Loose-object storage for one bare Git repository on disk. */
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import { MAX_DRAFT_BYTES } from "../../core/snapshot";
import { isMissing, writeFileAtomic } from "./atomic";
import { type GitObjectType, oidOf, wrap } from "./git-objects";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
/** Pretty-printed JSON and Git headers need modest headroom over a raw draft. */
const MAX_OBJECT_BYTES = MAX_DRAFT_BYTES * 3;

export class ObjectStore {
  private known = new Set<string>();
  constructor(readonly gitdir: string) {}

  /** Lay out a bare repository that `git --git-dir` understands. */
  async init(defaultBranch: string) {
    await mkdir(join(this.gitdir, "objects"), { recursive: true });
    await mkdir(join(this.gitdir, "refs", "heads"), { recursive: true });
    await writeFileAtomic(
      join(this.gitdir, "HEAD"),
      `ref: refs/heads/${defaultBranch}\n`,
    );
    await writeFileAtomic(
      join(this.gitdir, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n",
    );
    await writeFileAtomic(
      join(this.gitdir, "description"),
      "DraftBranch screenplay project. Managed by the DraftBranch desktop app.\n",
    );
  }

  private file(oid: string) {
    return join(this.gitdir, "objects", oid.slice(0, 2), oid.slice(2));
  }
  async has(oid: string): Promise<boolean> {
    if (this.known.has(oid)) return true;
    try {
      await access(this.file(oid));
      this.known.add(oid);
      return true;
    } catch {
      return false;
    }
  }
  /** Objects are named by their content, so writing one twice is harmless. */
  async put(type: GitObjectType, content: Buffer): Promise<string> {
    const oid = oidOf(type, content);
    if (await this.has(oid)) return oid;
    const path = this.file(oid);
    await mkdir(join(this.gitdir, "objects", oid.slice(0, 2)), {
      recursive: true,
    });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, await deflateAsync(wrap(type, content)));
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      // Another write of the same object won the race; that copy is identical.
      if (!(await this.has(oid))) throw error;
    }
    this.known.add(oid);
    return oid;
  }
  async get(
    oid: string,
    expected?: GitObjectType,
  ): Promise<{ type: GitObjectType; content: Buffer }> {
    let packed: Buffer;
    try {
      packed = await readFile(this.file(oid));
    } catch (error) {
      if (isMissing(error)) throw new MissingObject(oid);
      throw error;
    }
    const raw = await inflateAsync(packed, {
      maxOutputLength: MAX_OBJECT_BYTES,
    });
    if (createHash("sha1").update(raw).digest("hex") !== oid)
      throw new Error("A stored revision failed its integrity check.");
    const zero = raw.indexOf(0);
    const [type, length] = raw.subarray(0, zero).toString().split(" ");
    if (
      !["blob", "tree", "commit"].includes(type) ||
      Number(length) !== raw.length - zero - 1 ||
      (expected && type !== expected)
    )
      throw new Error("A stored revision has an unexpected format.");
    return { type: type as GitObjectType, content: raw.subarray(zero + 1) };
  }
}

export class MissingObject extends Error {
  constructor(readonly oid: string) {
    super("This revision's text has not been downloaded to this device yet.");
    this.name = "MissingObject";
  }
}
