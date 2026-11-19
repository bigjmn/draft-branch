import * as fs from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import git from "isomorphic-git";
import {
  type Actor,
  type Snapshot,
  MAX_DRAFT_BYTES,
  parseSnapshot,
  serializeSnapshot,
} from "./model";
import type { ObjectStore } from "./objects";

export interface GitRevision {
  oid: string;
  tree: string;
  blob: string;
  parent: string[];
}
export const objectPath = (projectId: string, oid: string) =>
  `projects/${projectId}/git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;

/** Real Git loose objects, written by isomorphic-git, persisted before refs move.
 * Firestore is the transactional ref store. No long-lived local disk is required.
 * This is an application Git service, not yet a git clone/push HTTP remote.
 */
export class GitService {
  constructor(private objects: ObjectStore) {}
  async commit(
    projectId: string,
    snapshot: Snapshot,
    parent: string[],
    message: string,
    actor: Actor,
    timestamp: number,
  ): Promise<GitRevision> {
    const dir = await mkdtemp(join(tmpdir(), "draftbranch-git-"));
    try {
      await git.init({ fs, dir, defaultBranch: "main" });
      const blob = await git.writeBlob({
        fs,
        dir,
        blob: Buffer.from(serializeSnapshot(snapshot)),
      });
      const tree = await git.writeTree({
        fs,
        dir,
        tree: [
          { mode: "100644", path: "screenplay.json", oid: blob, type: "blob" },
        ],
      });
      const author = {
        name: actor.name.replace(/[\n\r<>]/g, "").slice(0, 100) || "Writer",
        email: `${createHash("sha256").update(actor.uid).digest("hex").slice(0, 24)}@users.draftbranch.invalid`,
        timestamp,
        timezoneOffset: 0,
      };
      const oid = await git.writeCommit({
        fs,
        dir,
        commit: {
          tree,
          parent,
          message: message + "\n",
          author,
          committer: author,
        },
      });
      const objectsDir = join(dir, ".git", "objects");
      for (const prefix of await readdir(objectsDir)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
        for (const suffix of await readdir(join(objectsDir, prefix))) {
          await this.objects.put(
            objectPath(projectId, prefix + suffix),
            await readFile(join(objectsDir, prefix, suffix)),
            "application/octet-stream",
          );
        }
      }
      return { oid, tree, blob, parent };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async readSnapshot(projectId: string, blobOid: string): Promise<Snapshot> {
    const raw = inflateSync(
      await this.objects.get(objectPath(projectId, blobOid)),
      { maxOutputLength: MAX_DRAFT_BYTES * 3 },
    );
    if (createHash("sha1").update(raw).digest("hex") !== blobOid)
      throw new Error("Git object integrity mismatch.");
    const zero = raw.indexOf(0);
    if (raw.subarray(0, zero).toString() !== `blob ${raw.length - zero - 1}`)
      throw new Error("Expected a Git blob.");
    return parseSnapshot(JSON.parse(raw.subarray(zero + 1).toString()));
  }
}
