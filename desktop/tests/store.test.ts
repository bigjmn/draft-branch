import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serializeSnapshot } from "../src/core/snapshot";
import { LOCAL_SCOPE } from "../src/core/types";
import { block, script, tempLibrary } from "./helpers";

const author = { name: "Jesse" };
async function localProject(
  t: Parameters<typeof tempLibrary>[0],
  draft?: unknown,
) {
  const library = await tempLibrary(t);
  const meta = await library.createLocal({
    title: "Pilot",
    draft,
    authorName: "Jesse",
  });
  const ref = { scope: LOCAL_SCOPE, id: meta.id };
  return { library, ref, store: await library.open(ref) };
}
/** Type, save and commit on a branch, like the editor does. */
async function write(
  store: Awaited<ReturnType<typeof localProject>>["store"],
  branch: string,
  text: ReturnType<typeof script>,
  message?: string,
) {
  const loaded = await store.loadDraft(branch);
  const saved = await store.saveDraft({
    branch,
    baseCommit: loaded.baseCommit,
    expectedVersion: loaded.version,
    draft: text,
  });
  assert.equal(saved.status, "accepted");
  if (!message) return null;
  const committed = await store.commit({
    branch,
    expectedHead: loaded.head,
    draftVersion: saved.version!,
    message,
    author,
  });
  assert.equal(committed.status, "succeeded", committed.error);
  return committed.commitId!;
}

test("a project made on this device starts with one revision on a protected main branch", async (t) => {
  const { library, store } = await localProject(t);
  const state = await store.state();
  assert.equal(state.meta.title, "Pilot");
  assert.equal(state.meta.cloud, undefined);
  assert.deepEqual(
    state.branches.map((b) => [b.name, b.protected]),
    [["main", true]],
  );
  const [first] = await store.commits();
  assert.equal(first.message, "Create project");
  assert.equal(first.authorName, "Jesse");
  assert.deepEqual(first.parent, []);
  const draft = await store.loadDraft("main");
  assert.deepEqual(
    {
      version: draft.version,
      clean: draft.clean,
      stored: draft.stored,
      base: draft.baseCommit,
    },
    { version: 0, clean: true, stored: false, base: first.oid },
  );
  assert.equal(draft.draft.blocks.length, 1);
  assert.equal((await library.list(LOCAL_SCOPE)).length, 1);
  assert.match(
    (await library.list(LOCAL_SCOPE))[0].ref.id,
    /^local_[a-f0-9]{24}$/,
  );
});

test("an imported screenplay becomes the first revision under the project's title", async (t) => {
  const imported = script(
    "From the file",
    block("s1", "INT. HOUSE - DAY", "scene"),
    block("a1"),
  );
  const { store } = await localProject(t, imported);
  const draft = await store.loadDraft("main");
  assert.equal(draft.draft.title, "Pilot");
  assert.deepEqual(draft.draft.blocks, imported.blocks);
});

test("drafts save one version at a time and commits need the saved draft on the branch head", async (t) => {
  const { store } = await localProject(t);
  const start = await store.loadDraft("main");
  const text = script(
    "Pilot",
    block("s1", "INT. HOUSE - DAY", "scene"),
    block("a1", "A door opens."),
  );
  const first = await store.saveDraft({
    branch: "main",
    baseCommit: start.baseCommit,
    expectedVersion: 0,
    draft: text,
  });
  assert.deepEqual(first, { status: "accepted", version: 1 });
  // A second writer of the same version is refused instead of overwriting.
  assert.equal(
    (
      await store.saveDraft({
        branch: "main",
        baseCommit: start.baseCommit,
        expectedVersion: 0,
        draft: text,
      })
    ).status,
    "conflict",
  );
  assert.equal(
    (
      await store.saveDraft({
        branch: "main",
        baseCommit: start.baseCommit,
        expectedVersion: 1,
        draft: { title: "x", blocks: [] },
      })
    ).status,
    "rejected",
  );
  assert.equal((await store.loadDraft("main")).clean, false);
  assert.equal(
    (
      await store.commit({
        branch: "main",
        expectedHead: start.head,
        draftVersion: 0,
        message: "Stale",
        author,
      })
    ).status,
    "rejected",
  );
  assert.equal(
    (
      await store.commit({
        branch: "main",
        expectedHead: "0".repeat(40),
        draftVersion: 1,
        message: "Wrong head",
        author,
      })
    ).status,
    "conflict",
  );
  const committed = await store.commit({
    branch: "main",
    expectedHead: start.head,
    draftVersion: 1,
    message: "  Opening scene  ",
    author,
  });
  assert.equal(committed.status, "succeeded");
  const after = await store.loadDraft("main");
  assert.deepEqual(
    {
      version: after.version,
      base: after.baseCommit,
      head: after.head,
      clean: after.clean,
    },
    {
      version: 2,
      base: committed.commitId,
      head: committed.commitId,
      clean: true,
    },
  );
  const log = await store.commits();
  const head = log.find((c) => c.oid === committed.commitId)!;
  assert.equal(head.message, "Opening scene");
  assert.deepEqual(head.parent, [start.head]);
  assert.deepEqual(await store.readSnapshot(head.oid), text);
});

test("the repository is real Git: fsck passes and git shows the committed screenplay", async (t) => {
  const { store } = await localProject(t);
  const text = script(
    "Pilot",
    block("s1", "EXT. ROAD - DUSK", "scene"),
    block("a1", "Naïve café — “quotes”.\nSecond line."),
  );
  const oid = await write(store, "main", text, "Road scene");
  const gitDir = join(store.dir, "git");
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", gitDir, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
  git("fsck", "--strict", "--no-dangling");
  assert.equal(git("rev-parse", "main").trim(), oid);
  assert.equal(git("show", "main:screenplay.json"), serializeSnapshot(text));
  assert.match(
    git("log", "--format=%an|%ae|%s", "main"),
    /^Jesse\|[a-f0-9]{24}@users\.draftbranch\.invalid\|Road scene\n/,
  );
  assert.equal(git("symbolic-ref", "HEAD").trim(), "refs/heads/main");
});

test("branches keep separate drafts; a draft with no writing follows its branch", async (t) => {
  const { store } = await localProject(t);
  const root = (await store.loadDraft("main")).head;
  await assert.rejects(
    store.createBranch({
      name: "Bad Name",
      sourceBranch: "main",
      expectedHead: root,
    }),
  );
  await assert.rejects(
    store.createBranch({
      name: "alt",
      sourceBranch: "main",
      expectedHead: "1".repeat(40),
    }),
    /advanced/,
  );
  const alt = await store.createBranch({
    name: "alt",
    sourceBranch: "main",
    expectedHead: root,
  });
  assert.deepEqual(alt, {
    name: "alt",
    head: root,
    protected: false,
    source: "main",
  });
  await assert.rejects(
    store.createBranch({
      name: "alt",
      sourceBranch: "main",
      expectedHead: root,
    }),
    /already exists/,
  );

  const altText = script("Pilot", block("s1", "INT. ALT - NIGHT", "scene"));
  await write(store, "alt", altText); // saved, not committed
  const mainText = script("Pilot", block("s1", "INT. MAIN - DAY", "scene"));
  const mainHead = await write(store, "main", mainText, "Main scene");
  assert.deepEqual((await store.loadDraft("alt")).draft, altText);
  assert.equal((await store.loadDraft("alt")).clean, false);

  // Move main on again underneath its clean draft: the draft follows.
  const next = script(
    "Pilot",
    block("s1", "INT. MAIN - DAY", "scene"),
    block("a1"),
  );
  const made = await store.createCommit({
    parent: [mainHead!],
    snapshot: next,
    message: "Arrived by sync",
    authorName: "Bob",
    authorKey: "bobkey",
    timestamp: 1_800_000_000,
  });
  await store.updateRefs({
    branches: { main: { head: made.oid, expected: mainHead! } },
  });
  const followed = await store.loadDraft("main");
  assert.deepEqual(followed.draft, next);
  assert.deepEqual([followed.baseCommit, followed.clean], [made.oid, true]);
  // The draft with writing stays on its base, ready for "Bring in updates".
  assert.equal((await store.loadDraft("alt")).baseCommit, root);
  const summaries = (await store.state()).drafts;
  assert.deepEqual(summaries.map((d) => [d.branch, d.clean]).sort(), [
    ["alt", false],
    ["main", true],
  ]);
});

test("a merge revision has both parents and records which branches it joined", async (t) => {
  const { store } = await localProject(t);
  const root = (await store.loadDraft("main")).head;
  await store.createBranch({
    name: "alt",
    sourceBranch: "main",
    expectedHead: root,
  });
  const altHead = await write(
    store,
    "alt",
    script("Pilot", block("s1", "INT. ALT", "scene")),
    "Alt",
  );
  const merged = script("Pilot", block("s1", "INT. ALT", "scene"), block("a9"));
  await assert.rejects(
    store.mergeCommit({
      sourceBranch: "alt",
      targetBranch: "main",
      expectedSourceHead: root,
      expectedTargetHead: root,
      snapshot: merged,
      message: "Merge alt into main",
      author,
    }),
    /changed/,
  );
  const { oid } = await store.mergeCommit({
    sourceBranch: "alt",
    targetBranch: "main",
    expectedSourceHead: altHead!,
    expectedTargetHead: root,
    snapshot: merged,
    message: "Merge alt into main",
    author,
  });
  const commit = (await store.commits()).find((c) => c.oid === oid)!;
  assert.deepEqual(commit.parent, [root, altHead]);
  assert.deepEqual(commit.merge, { sourceBranch: "alt", targetBranch: "main" });
  assert.equal((await store.loadDraft("main")).head, oid);
  assert.deepEqual((await store.loadDraft("main")).draft, merged);
});

test("cloud roles are enforced on the device: editors cannot commit to main, readers cannot write", async (t) => {
  const library = await tempLibrary(t);
  await library.createClone({
    uid: "u1",
    projectId: "p1",
    title: "Shared",
    role: "editor",
  });
  const store = await library.open({ scope: "u1", id: "p1" });
  const first = await store.createCommit({
    parent: [],
    snapshot: script("Shared", block("s1", "", "scene")),
    message: "Create project",
    authorName: "Owner",
    authorKey: "ownerkey",
    timestamp: 1_800_000_000,
  });
  await store.updateRefs({
    branches: { main: { head: first.oid, expected: null, protected: true } },
  });
  const draft = await store.loadDraft("main");
  const saved = await store.saveDraft({
    branch: "main",
    baseCommit: draft.baseCommit,
    expectedVersion: 0,
    draft: script("Shared", block("s1", "INT. X", "scene")),
  });
  assert.equal(saved.status, "accepted");
  const refused = await store.commit({
    branch: "main",
    expectedHead: first.oid,
    draftVersion: 1,
    message: "Nope",
    author,
  });
  assert.equal(refused.status, "rejected");
  assert.match(refused.error!, /can’t commit to this protected branch/);

  await store.createBranch({
    name: "mine",
    sourceBranch: "main",
    expectedHead: first.oid,
  });
  assert.equal(
    (await write(
      store,
      "mine",
      script("Shared", block("s1", "INT. MINE", "scene")),
      "Mine",
    )) !== null,
    true,
  );
  await assert.rejects(
    store.mergeCommit({
      sourceBranch: "mine",
      targetBranch: "main",
      expectedSourceHead: first.oid,
      expectedTargetHead: first.oid,
      snapshot: script("Shared", block("s1")),
      message: "m",
      author,
    }),
    /merged online/,
  );
  await store.setMeta({ cloud: { role: "reviewer" } });
  assert.equal(
    (
      await store.saveDraft({
        branch: "mine",
        baseCommit: first.oid,
        expectedVersion: 0,
        draft: script("Shared", block("s1")),
      })
    ).status,
    "rejected",
  );
  await assert.rejects(
    store.createBranch({
      name: "other",
      sourceBranch: "main",
      expectedHead: first.oid,
    }),
    /Read-only/,
  );
  // Commenters are read-only too.
  await store.setMeta({ cloud: { role: "commenter" } });
  assert.equal(
    (
      await store.saveDraft({
        branch: "mine",
        baseCommit: first.oid,
        expectedVersion: 0,
        draft: script("Shared", block("s1")),
      })
    ).status,
    "rejected",
  );
  // An editor the owner allowed to edit main commits there.
  await store.setMeta({
    cloud: {
      role: "editor",
      options: { editMain: true, commentMain: true, branch: null },
    },
  });
  const onMain = await store.loadDraft("main");
  const allowed = await store.commit({
    branch: "main",
    expectedHead: first.oid,
    draftVersion: onMain.version,
    message: "Allowed",
    author,
  });
  assert.equal(allowed.status, "succeeded", allowed.error);
  assert.equal((await store.state()).meta.cloud?.options?.editMain, true);
  // Pulling the same project twice reuses the copy that is already here.
  const again = await library.createClone({
    uid: "u1",
    projectId: "p1",
    title: "Renamed",
    role: "owner",
  });
  assert.equal(again.title, "Shared");
});

test("ref updates are compare-and-swap, and library data survives reopening from disk", async (t) => {
  const { library, ref, store } = await localProject(t);
  const root = (await store.loadDraft("main")).head;
  const text = script("Pilot", block("s1", "INT. ROOM", "scene"));
  const head = await write(store, "main", text, "Room");
  await assert.rejects(
    store.updateRefs({ branches: { main: { head: root, expected: root } } }),
    /changed while syncing/,
  );
  await assert.rejects(
    store.updateRefs({ branches: { main: { head: "2".repeat(40) } } }),
    /Invalid branch update/,
  );
  await store.setMeta({ title: "Pilot, revised", lastBranch: "main" });
  // A second Library on the same folder is what the next launch sees.
  const { Library } = await import("../src/main/store/library");
  const reopened = await new Library(library.root).open(ref);
  const state = await reopened.state();
  assert.equal(state.meta.title, "Pilot, revised");
  assert.equal(state.branches[0].head, head);
  assert.deepEqual((await reopened.loadDraft("main")).draft, text);
  assert.equal(
    (await new Library(library.root).settings()).writerId,
    (await library.settings()).writerId,
  );
  // No temporary files are left behind by atomic writes.
  const leftovers = (await readdir(store.dir)).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);
});

test("a damaged draft file falls back to the previous save instead of losing writing", async (t) => {
  const { library, ref, store } = await localProject(t);
  const one = script("Pilot", block("s1", "ONE", "scene"));
  const two = script("Pilot", block("s1", "TWO", "scene"));
  await write(store, "main", one);
  await write(store, "main", two);
  const path = join(store.dir, "drafts", "b-main.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).draft, two);
  await writeFile(path, "{ truncated");
  const { Library } = await import("../src/main/store/library");
  const recovered = await (
    await new Library(library.root).open(ref)
  ).loadDraft("main");
  assert.deepEqual(recovered.draft, one);
  assert.equal(recovered.version, 1);
});

test("removing a project deletes only that project's folder", async (t) => {
  const { library, ref } = await localProject(t);
  const other = await library.createLocal({ title: "Keep me" });
  await library.remove(ref);
  const left = await library.list(LOCAL_SCOPE);
  assert.deepEqual(
    left.map((p) => p.meta.id),
    [other.id],
  );
  await assert.rejects(
    library.open({ scope: LOCAL_SCOPE, id: "../../etc" }),
    /Invalid project/,
  );
  await assert.rejects(
    library.remove({ scope: "../..", id: "x" }),
    /Invalid account/,
  );
});
