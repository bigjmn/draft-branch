/** The device rebuilds cloud revisions from their metadata. That only works if
 * it produces the very bytes the backend's Git service writes. These tests run
 * the backend's own code (functions/src/projects) and compare.
 *
 * They need the backend's dependencies: `npm ci --prefix functions`. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import * as device from "../src/core/snapshot";
import { accountAuthorKey, decodeCommit } from "../src/main/store/git-objects";
import { block, tempLibrary } from "./helpers";

const functionsDir = join(import.meta.dirname, "..", "..", "functions");
const skip = existsSync(join(functionsDir, "node_modules", "isomorphic-git"))
  ? false
  : "backend dependencies are not installed (npm ci --prefix functions)";

class MemoryObjects {
  data = new Map<string, Buffer>();
  async put(path: string, bytes: Buffer) {
    this.data.set(path, Buffer.from(bytes));
  }
  async get(path: string) {
    const value = this.data.get(path);
    if (!value) throw new Error("Object missing: " + path);
    return value;
  }
}
const samples: unknown[] = [
  {
    title: "Pilot",
    blocks: [{ id: "initial-scene", type: "scene", text: "" }],
  },
  {
    schemaVersion: 1,
    title: "Ünïcödé — “quotes” & <tags>",
    blocks: [
      { id: "  padded-id ", type: "scene", text: "INT. CAFÉ - DAY" },
      {
        id: "b_2",
        type: "action",
        text: "Line one.\nLine two.\r\nTabs\tand emoji 🎬 and a lone surrogate \ud83c.",
      },
      { id: "c-3", type: "character", text: "ELLA", extra: "dropped" },
      { id: "d4", type: "dialogue", text: 'He said "no" \\ and left.' },
      { id: "e5", type: "parenthetical", text: "(beat)" },
      { id: "f6", type: "shot", text: "CLOSE ON" },
      { id: "g7", type: "transition", text: "CUT TO:" },
    ],
  },
  {
    title: "With a title page",
    titlePage: {
      contact: "J Nicks Productions\n130 Hope St.\r\n“Brooklyn” 🎬",
      authors: "Jesse Nicholas & Ünïcödé",
      credit: "written by",
      title: "THIS HOUSE IS THE WORST",
      extra: "dropped",
    },
    blocks: [{ id: "a", type: "scene", text: "INT. HOUSE - DAY" }],
  },
  {
    title: "No title page",
    titlePage: null,
    blocks: [{ id: "a", type: "scene", text: "" }],
  },
];

test(
  "snapshots canonicalize to the same bytes as the backend",
  { skip },
  async () => {
    const backend = await import("../../functions/src/projects/model");
    for (const sample of samples) {
      assert.equal(
        device.serializeSnapshot(sample),
        backend.serializeSnapshot(sample),
      );
      assert.deepEqual(
        device.parseSnapshot(sample),
        backend.parseSnapshot(sample),
      );
    }
    assert.deepEqual(device.blankSnapshot("T"), backend.blankSnapshot("T"));
    for (const [title, author, draft] of [
      ["Pilot", "Jesse Nicholas", undefined],
      ["Untitled screenplay", "", undefined],
      ["  ", "A\nB", undefined],
      ["Imported", "Me", samples[1]],
      [
        "Own page",
        "Me",
        {
          ...(samples[0] as object),
          titlePage: {
            title: "MINE",
            credit: "by",
            authors: "X",
            contact: "",
          },
        },
      ],
    ] as const)
      assert.equal(
        device.serializeSnapshot(
          device.newProjectSnapshot(title, author, draft),
        ),
        backend.serializeSnapshot(
          backend.newProjectSnapshot(title, author, draft),
        ),
      );
    assert.equal(device.MAX_DRAFT_BYTES, backend.MAX_DRAFT_BYTES);
    assert.deepEqual([...device.ELEMENT_TYPES], [...backend.ELEMENT_TYPES]);
    const invalid: unknown[] = [
      null,
      { title: "x", blocks: [] },
      {
        title: "x".repeat(201),
        blocks: [{ id: "a", type: "scene", text: "" }],
      },
      {
        schemaVersion: 2,
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "" }],
      },
      { title: "x", blocks: [{ id: "a/b", type: "scene", text: "" }] },
      { title: "x", blocks: [{ id: "a", type: "poem", text: "" }] },
      {
        title: "x",
        blocks: [
          { id: "a", type: "scene", text: "" },
          { id: "a", type: "action", text: "" },
        ],
      },
      {
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "y".repeat(100001) }],
      },
      {
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "" }],
        titlePage: { title: "T", credit: "by", authors: 3, contact: "" },
      },
      {
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "" }],
        titlePage: { title: "T", credit: "by", authors: "A" },
      },
      {
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "" }],
        titlePage: {
          title: "T".repeat(501),
          credit: "",
          authors: "",
          contact: "",
        },
      },
      {
        title: "x",
        blocks: [{ id: "a", type: "scene", text: "" }],
        titlePage: "cover",
      },
    ];
    for (const value of invalid) {
      assert.throws(() => backend.parseSnapshot(value));
      assert.throws(() => device.parseSnapshot(value), device.InvalidInput);
    }
    for (const name of [
      "main",
      "alternate-ending",
      "a1-b2",
      "Main",
      "-x",
      "x-",
      "a--b",
      "x".repeat(65),
      "",
    ]) {
      let accepted = true;
      try {
        backend.branchId(name);
      } catch {
        accepted = false;
      }
      assert.equal(device.isBranchName(name), accepted, name);
    }
  },
);

test(
  "revisions rebuilt from cloud metadata are byte-identical to the backend's commits",
  { skip },
  async (t) => {
    const { GitService } = await import("../../functions/src/projects/git");
    const backend = await import("../../functions/src/projects/model");
    const objects = new MemoryObjects();
    const git = new GitService(objects);
    const actors = [
      {
        uid: "aLiCe0123456789ABCDEFuid",
        name: "Alice Example",
        email: "alice@example.com",
        emailVerified: true,
      },
      // No profile name: the backend falls back to the email's local part.
      {
        uid: "bob-uid_2",
        name: "Writer",
        email: "bob.writer@example.com",
        emailVerified: true,
      },
      {
        uid: "carol",
        name: "  Carol <c>\n",
        email: null,
        emailVerified: false,
      },
    ];
    const messages = [
      "Create project",
      "Opening scene",
      "Multi-line\n\nBody text here",
      "Trailing space fixed",
    ];
    const library = await tempLibrary(t);
    await library.createClone({
      uid: actors[0].uid,
      projectId: "parity",
      title: "Parity",
      role: "owner",
    });
    const store = await library.open({ scope: actors[0].uid, id: "parity" });

    let parent: string[] = [];
    let timestamp = 1_700_000_000;
    const made: { oid: string; blob: string; snapshot: unknown }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const actor = actors[i % actors.length];
      const snapshot = backend.parseSnapshot(samples[i % samples.length]);
      const mergeParents = i === 3 ? [parent[0], made[0].oid] : parent;
      const revision = await git.commit(
        "parity",
        snapshot,
        mergeParents,
        messages[i],
        actor,
        timestamp++,
      );
      // What a Firestore commit document holds.
      const [result] = await store.importCommits([
        {
          oid: revision.oid,
          tree: revision.tree,
          blob: revision.blob,
          parent: revision.parent,
          message: messages[i],
          actorUid: actor.uid,
          authorNames: [backend.authorName(actor)],
          timestamp: timestamp - 1,
        },
      ]);
      assert.deepEqual(
        result,
        { oid: revision.oid, local: revision.oid, exact: true },
        messages[i],
      );
      assert.deepEqual(await store.writeSnapshot(snapshot, revision.blob), {
        blob: revision.blob,
      });
      made.push({ oid: revision.oid, blob: revision.blob, snapshot });
      parent = [revision.oid];
    }
    // Byte-for-byte, not only by id: compare the stored commit with the backend's object.
    const last = made.at(-1)!;
    const raw = inflateSync(
      objects.data.get(
        `projects/parity/git/objects/${last.oid.slice(0, 2)}/${last.oid.slice(2)}`,
      )!,
    );
    const fields = decodeCommit(raw.subarray(raw.indexOf(0) + 1));
    assert.equal(
      fields.author.email,
      `${accountAuthorKey(actors[0].uid)}@users.draftbranch.invalid`,
    );
    assert.equal(fields.message, messages[3]);
    assert.deepEqual(await store.readSnapshot(last.oid), last.snapshot);
    assert.deepEqual(
      await git.readSnapshot("parity", last.blob),
      await store.readBlob(last.blob),
    );
    assert.deepEqual(await store.syncState(), { oidMap: {}, drafts: {} });
  },
);

test(
  "a revision whose author name is unknown is still usable, under a mapped id",
  { skip },
  async (t) => {
    const { GitService } = await import("../../functions/src/projects/git");
    const backend = await import("../../functions/src/projects/model");
    const git = new GitService(new MemoryObjects());
    const actor = {
      uid: "legacy",
      name: "Name At The Time",
      email: "l@example.com",
      emailVerified: true,
    };
    const snapshot = backend.parseSnapshot({
      title: "Old",
      blocks: [block("a", "", "scene")],
    });
    const first = await git.commit(
      "p",
      snapshot,
      [],
      "Create project",
      actor,
      1_700_000_000,
    );
    const second = await git.commit(
      "p",
      snapshot,
      [first.oid],
      "Second",
      actor,
      1_700_000_001,
    );
    const library = await tempLibrary(t);
    await library.createClone({
      uid: "legacy",
      projectId: "p",
      title: "Old",
      role: "owner",
    });
    const store = await library.open({ scope: "legacy", id: "p" });
    const doc = (
      revision: typeof first,
      message: string,
      timestamp: number,
      authorNames: string[],
    ) => ({
      oid: revision.oid,
      tree: revision.tree,
      blob: revision.blob,
      parent: revision.parent,
      message,
      actorUid: actor.uid,
      authorNames,
      timestamp,
    });
    // Candidates are tried in order; the right one is found even if not first.
    const [found] = await store.importCommits([
      doc(first, "Create project", 1_700_000_000, [
        "Wrong Guess",
        "Name At The Time",
        "Writer",
      ]),
    ]);
    assert.equal(found.exact, true);
    const other = await library.createClone({
      uid: "legacy",
      projectId: "p2",
      title: "Old",
      role: "owner",
    });
    const blind = await library.open({ scope: "legacy", id: other.id });
    const results = await blind.importCommits([
      doc(first, "Create project", 1_700_000_000, ["Wrong Guess"]),
      doc(second, "Second", 1_700_000_001, ["Name At The Time"]),
    ]);
    assert.equal(results[0].exact, false);
    assert.notEqual(results[0].local, first.oid);
    // The child cannot match either, because its parent id differs here.
    assert.equal(results[1].exact, false);
    const { oidMap } = await blind.syncState();
    assert.deepEqual(
      Object.keys(oidMap).sort(),
      [first.oid, second.oid].sort(),
    );
    await blind.writeSnapshot(snapshot, first.blob);
    assert.deepEqual(await blind.readSnapshot(oidMap[second.oid]), snapshot);
  },
);
