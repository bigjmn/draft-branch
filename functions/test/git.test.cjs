const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitService } = require("../lib/projects/git");
const {
  parseSnapshot,
  serializeSnapshot,
  blankSnapshot,
  assertPublish,
} = require("../lib/projects/model");

class MemoryObjects {
  data = new Map();
  async put(path, bytes) {
    if (this.data.has(path)) assert.deepEqual(this.data.get(path), bytes);
    this.data.set(path, Buffer.from(bytes));
  }
  async get(path) {
    if (!this.data.has(path)) throw new Error("Object missing: " + path);
    return this.data.get(path);
  }
}
module.exports = { MemoryObjects };

test("native Git can read and fsck exported objects; retries create identical commits", async () => {
  const objects = new MemoryObjects(),
    git = new GitService(objects);
  const actor = {
    uid: "alice",
    name: "Alice",
    email: "private@example.com",
    emailVerified: true,
  };
  const first = await git.commit(
    "project",
    blankSnapshot("Pilot"),
    [],
    "Create project",
    actor,
    1700000000,
  );
  const draft = parseSnapshot({
    title: "Pilot",
    blocks: [
      { id: "scene-1", type: "scene", text: "INT. HOUSE - DAY" },
      { id: "action-1", type: "action", text: "A door opens." },
    ],
  });
  const second = await git.commit(
    "project",
    draft,
    [first.oid],
    "Opening scene",
    actor,
    1700000001,
  );
  assert.equal(
    (
      await git.commit(
        "project",
        draft,
        [first.oid],
        "Opening scene",
        actor,
        1700000001,
      )
    ).oid,
    second.oid,
  );
  assert.deepEqual(await git.readSnapshot("project", second.blob), draft);
  const dir = await mkdtemp(join(tmpdir(), "draftbranch-native-test-"));
  try {
    execFileSync("git", ["init", "--quiet", dir]);
    for (const [path, bytes] of objects.data) {
      const dest = join(dir, ".git", path.replace("projects/project/git/", ""));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }
    execFileSync("git", [
      "-C",
      dir,
      "update-ref",
      "refs/heads/main",
      second.oid,
    ]);
    execFileSync("git", ["-C", dir, "symbolic-ref", "HEAD", "refs/heads/main"]);
    execFileSync("git", ["-C", dir, "fsck", "--strict"], { stdio: "pipe" });
    const output = execFileSync(
      "git",
      ["-C", dir, "show", "main:screenplay.json"],
      { encoding: "utf8" },
    );
    assert.equal(output, serializeSnapshot(draft));
    const commit = execFileSync(
      "git",
      ["-C", dir, "cat-file", "-p", second.oid],
      { encoding: "utf8" },
    );
    assert.match(commit, new RegExp("parent " + first.oid));
    assert.ok(!commit.includes(actor.email));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("validation rejects duplicate IDs, unsupported versions, oversized text and path-like IDs", () => {
  const d = blankSnapshot("Test");
  assert.throws(() => parseSnapshot({ ...d, schemaVersion: 2 }));
  assert.throws(() =>
    parseSnapshot({ ...d, blocks: [d.blocks[0], d.blocks[0]] }),
  );
  assert.throws(() =>
    parseSnapshot({ ...d, blocks: [{ ...d.blocks[0], id: "../../x" }] }),
  );
  assert.throws(() =>
    parseSnapshot({
      ...d,
      blocks: [{ ...d.blocks[0], text: "x".repeat(100001) }],
    }),
  );
});
test("protected branches accept owners only, regular branches allow editors", () => {
  assert.throws(() => assertPublish("editor", { protected: true }));
  assert.throws(() => assertPublish("reviewer", { protected: false }));
  assert.doesNotThrow(() => assertPublish("owner", { protected: true }));
  assert.doesNotThrow(() => assertPublish("editor", { protected: false }));
});
