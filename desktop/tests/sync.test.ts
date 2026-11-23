import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resolution } from "../../functions/src/projects/merge";
import type { Snapshot } from "../src/core/snapshot";
import {
  type ConflictRequest,
  type SyncOptions,
  syncProject,
} from "../src/core/sync/engine";
import { projectStatus } from "../src/core/sync/status";
import type { ProjectStore } from "../src/main/store/project-store";
import { FakeCloud, alice, block, bob, script, tempLibrary } from "./helpers";

const PID = "project-1";
const scene = (text: string) => block("initial-scene", text, "scene");
type T = Parameters<typeof tempLibrary>[0];

/** A cloud project, and a device where `who` has pulled it. */
async function pulled(t: T, who = alice, setup?: (cloud: FakeCloud) => void) {
  const cloud = new FakeCloud();
  cloud.createProject(PID, alice, "Pilot");
  if (who !== alice) cloud.addMember(PID, who.uid, "editor");
  setup?.(cloud);
  const library = await tempLibrary(t);
  const role = who === alice ? "owner" : "editor";
  await library.createClone({
    uid: who.uid,
    projectId: PID,
    title: "Pilot",
    role,
  });
  const store = await library.open({ scope: who.uid, id: PID });
  const api = cloud.as(who);
  const sync = (options: SyncOptions = {}) => syncProject(api, store, options);
  const first = await sync({ allDrafts: true });
  assert.equal(first.ok, true, first.error);
  return { cloud, library, store, sync, api };
}
async function write(
  store: ProjectStore,
  branch: string,
  text: Snapshot,
  message?: string,
) {
  const loaded = await store.loadDraft(branch);
  const saved = await store.saveDraft({
    branch,
    baseCommit: loaded.baseCommit,
    expectedVersion: loaded.version,
    draft: text,
  });
  assert.equal(saved.status, "accepted", saved.error);
  if (!message) return null;
  const done = await store.commit({
    branch,
    expectedHead: loaded.head,
    draftVersion: saved.version!,
    message,
    author: { name: "Offline Me" },
  });
  assert.equal(done.status, "succeeded", done.error);
  return done.commitId!;
}
const heads = async (store: ProjectStore) =>
  Object.fromEntries(
    (await store.state()).branches.map((b) => [b.name, b.head]),
  );
async function status(store: ProjectStore) {
  const s = projectStatus(await store.state(), await store.commits());
  return {
    revisions: s.unpublishedRevisions,
    branches: s.unpublishedBranches,
    incoming: s.incoming,
  };
}
const clean = { revisions: 0, branches: 0, incoming: 0 };

test("pulling brings down every branch, the whole history, and the web working draft", async (t) => {
  const inProgress = script(
    "Pilot",
    scene("INT. KITCHEN - DAY"),
    block("a1", "Typed on the web, never committed."),
  );
  const { cloud, store, library } = await pulled(t, alice, (c) => {
    c.webCommit(
      PID,
      alice,
      "main",
      script("Pilot", scene("INT. KITCHEN - DAY")),
      "First scene",
    );
    c.webBranch(PID, "alt", "main");
    c.webCommit(
      PID,
      alice,
      "alt",
      script("Pilot", scene("INT. KITCHEN - NIGHT")),
      "Night version",
    );
    c.webMerge(PID, alice, "alt", "main");
    c.webDraft(PID, alice, "main", inProgress);
  });
  assert.deepEqual(await heads(store), {
    main: cloud.head(PID, "main"),
    alt: cloud.head(PID, "alt"),
  });
  const state = await store.state();
  assert.equal(state.meta.cloud?.cloned, true);
  assert.deepEqual(
    state.branches.find((b) => b.name === "main")?.protected,
    true,
  );
  const commits = await store.commits();
  assert.equal(commits.length, 4);
  assert.ok(commits.every((c) => c.hasContent));
  assert.deepEqual(await store.syncState().then((s) => s.oidMap), {});
  const merge = commits.find((c) => c.parent.length === 2)!;
  assert.deepEqual(merge.merge, { sourceBranch: "alt", targetBranch: "main" });
  assert.equal(
    commits.find((c) => c.message === "First scene")?.authorName,
    "Alice",
  );
  // The writing that only existed as a cloud working draft is on the device.
  const draft = await store.loadDraft("main");
  assert.deepEqual(draft.draft, inProgress);
  assert.equal(draft.clean, false);
  assert.deepEqual(await status(store), clean);
  assert.equal((await library.list(alice.uid))[0].drafts, 1);
});

test("revisions committed offline are published in order and replaced by the cloud's revisions", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  const one = script("Pilot", scene("INT. ONE"));
  const two = script("Pilot", scene("INT. ONE"), block("a1", "Two."));
  const working = script(
    "Pilot",
    scene("INT. ONE"),
    block("a1", "Two."),
    block("a2", "Still typing."),
  );
  const first = await write(store, "main", one, "Scene one");
  const second = await write(store, "main", two, "Add action");
  await write(store, "main", working);
  assert.deepEqual(await status(store), {
    revisions: 2,
    branches: 0,
    incoming: 0,
  });

  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.attention, []);
  assert.deepEqual(report.published, { main: 2 });
  assert.deepEqual(report.draftsPushed, ["main"]);
  assert.deepEqual(cloud.log(PID, "main"), [
    "Add action",
    "Scene one",
    "Create project",
  ]);
  assert.deepEqual(cloud.text(PID, "main"), two);
  // The device now holds the cloud's own commits, not its offline originals.
  const head = (await heads(store)).main;
  assert.equal(head, cloud.head(PID, "main"));
  assert.notEqual(head, second);
  const log = await store.commits();
  assert.ok(!log.some((c) => c.oid === first || c.oid === second));
  assert.ok(log.every((c) => c.authorName === "Alice"));
  assert.deepEqual(await status(store), clean);
  // Uncommitted writing survived, moved onto the published revision, and reached the cloud.
  const draft = await store.loadDraft("main");
  assert.deepEqual(
    [draft.draft, draft.baseCommit, draft.clean],
    [working, head, false],
  );
  assert.deepEqual(
    (await cloud.as(alice).loadDraft(PID, "main")).draft,
    working,
  );
  // Nothing left to do: a second sync makes no cloud writes.
  const before = { ...cloud.calls };
  const again = await sync();
  assert.equal(again.ok, true);
  assert.equal(cloud.calls.saveDraft, before.saveDraft);
  assert.equal(cloud.calls.commitDraft, before.commitDraft);
  assert.equal(again.changedLocal, false);
});

test("a branch with nothing new of its own fast-forwards; unsaved writing waits for Bring in updates", async (t) => {
  const { cloud, store, sync } = await pulled(t, bob);
  const root = (await heads(store)).main;
  const typing = script(
    "Pilot",
    scene(""),
    block("mine", "Bob's unsaved line."),
  );
  await write(store, "main", typing);
  const theirs = script("Pilot", scene("INT. ALICE"));
  cloud.webCommit(PID, alice, "main", theirs, "Alice writes");
  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.fastForwarded, ["main"]);
  assert.equal(report.fetched, 1);
  assert.equal((await heads(store)).main, cloud.head(PID, "main"));
  const draft = await store.loadDraft("main");
  // Still Bob's text on its old base: the editor offers to bring the update in.
  assert.deepEqual(
    [draft.draft, draft.baseCommit, draft.clean],
    [typing, root, false],
  );
  assert.deepEqual(await store.readSnapshot(draft.head), theirs);
});

test("offline revisions are replayed onto newer cloud revisions without losing either side", async (t) => {
  const { cloud, store, sync } = await pulled(t, alice, (c) =>
    c.webCommit(
      PID,
      alice,
      "main",
      script(
        "Pilot",
        scene("INT. HOUSE"),
        block("a1", "One."),
        block("a2", "Two."),
      ),
      "Base",
    ),
  );
  await write(
    store,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "One, edited offline."),
      block("a2", "Two."),
    ),
    "Edit one",
  );
  await write(
    store,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "One, edited offline."),
      block("a2", "Two."),
      block("a3", "Three."),
    ),
    "Add three",
  );
  cloud.webCommit(
    PID,
    alice,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "One."),
      block("a2", "Two, edited on the web."),
    ),
    "Web edit",
  );
  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.replayed, ["main"]);
  assert.deepEqual(report.published, { main: 2 });
  assert.deepEqual(cloud.log(PID, "main"), [
    "Add three",
    "Edit one",
    "Web edit",
    "Base",
    "Create project",
  ]);
  assert.deepEqual(
    cloud.text(PID, "main").blocks.map((b) => b.text),
    ["INT. HOUSE", "One, edited offline.", "Two, edited on the web.", "Three."],
  );
  assert.equal((await heads(store)).main, cloud.head(PID, "main"));
  assert.deepEqual(await status(store), clean);
});

test("overlapping edits ask the writer; declining leaves both sides untouched", async (t) => {
  const { cloud, store, sync } = await pulled(t, alice, (c) =>
    c.webCommit(
      PID,
      alice,
      "main",
      script("Pilot", scene("INT. HOUSE"), block("a1", "Original.")),
      "Base",
    ),
  );
  const offline = await write(
    store,
    "main",
    script("Pilot", scene("INT. HOUSE"), block("a1", "Offline wording.")),
    "Reword",
  );
  cloud.webCommit(
    PID,
    alice,
    "main",
    script("Pilot", scene("INT. HOUSE"), block("a1", "Web wording.")),
    "Web reword",
  );
  const cloudHead = cloud.head(PID, "main");

  const declined = await sync({ hooks: { resolve: async () => null } });
  assert.equal(declined.ok, true);
  assert.deepEqual(declined.attention, [{ kind: "diverged", branch: "main" }]);
  assert.equal((await heads(store)).main, offline);
  assert.equal(cloud.head(PID, "main"), cloudHead);
  assert.deepEqual(await status(store), {
    revisions: 1,
    branches: 0,
    incoming: 1,
  });

  const asked: ConflictRequest[] = [];
  const resolved = await sync({
    hooks: {
      resolve: async (request) => {
        asked.push(request);
        return { "block:a1": { text: "Agreed wording." } } satisfies Record<
          string,
          Resolution
        >;
      },
    },
  });
  assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(resolved.attention, []);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "revision");
  assert.equal(asked[0].target.blocks[1].text, "Web wording.");
  assert.equal(asked[0].source.blocks[1].text, "Offline wording.");
  assert.deepEqual(cloud.log(PID, "main").slice(0, 2), [
    "Reword",
    "Web reword",
  ]);
  assert.equal(cloud.text(PID, "main").blocks[1].text, "Agreed wording.");
  assert.deepEqual(await status(store), clean);
});

test("branches made offline are published, including one that starts from an unpublished revision", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  const root = (await heads(store)).main;
  // empty-branch: created, nothing committed. alt: forked before main moved.
  await store.createBranch({
    name: "empty-branch",
    sourceBranch: "main",
    expectedHead: root,
  });
  await store.createBranch({
    name: "alt",
    sourceBranch: "main",
    expectedHead: root,
  });
  await write(store, "alt", script("Pilot", scene("INT. ALT")), "Alt one");
  const mainOne = await write(
    store,
    "main",
    script("Pilot", scene("INT. MAIN")),
    "Main one",
  );
  // late: forked from main's unpublished revision, then both moved on.
  await store.createBranch({
    name: "late",
    sourceBranch: "main",
    expectedHead: mainOne!,
  });
  await write(
    store,
    "late",
    script("Pilot", scene("INT. MAIN"), block("l1", "Late.")),
    "Late one",
  );
  await write(
    store,
    "main",
    script("Pilot", scene("INT. MAIN"), block("m2", "Main two.")),
    "Main two",
  );
  assert.deepEqual(await status(store), {
    revisions: 4,
    branches: 3,
    incoming: 0,
  });

  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.attention, []);
  assert.deepEqual(report.publishedBranches.sort(), [
    "alt",
    "empty-branch",
    "late",
  ]);
  assert.deepEqual(report.published, { alt: 1, main: 2, late: 1 });
  assert.deepEqual(cloud.log(PID, "main"), [
    "Main two",
    "Main one",
    "Create project",
  ]);
  assert.deepEqual(cloud.log(PID, "alt"), ["Alt one", "Create project"]);
  assert.deepEqual(cloud.log(PID, "late"), [
    "Late one",
    "Main one",
    "Create project",
  ]);
  assert.deepEqual(cloud.log(PID, "empty-branch"), ["Create project"]);
  // "Main one" exists once in the cloud and is shared by main and late.
  assert.equal(cloud.projects.get(PID)!.commits.size, 5);
  const local = await heads(store);
  for (const name of ["main", "alt", "late", "empty-branch"])
    assert.equal(local[name], cloud.head(PID, name), name);
  assert.deepEqual(await status(store), clean);
});

test("a branch made from a revision that is no longer any cloud head is reported, not forced", async (t) => {
  const { cloud, store, sync } = await pulled(t, bob);
  const root = (await heads(store)).main;
  await store.createBranch({
    name: "idea",
    sourceBranch: "main",
    expectedHead: root,
  });
  cloud.webCommit(
    PID,
    alice,
    "main",
    script("Pilot", scene("INT. MOVED ON")),
    "Main moved",
  );
  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.attention, [
    { kind: "stale-branch", branch: "idea" },
  ]);
  assert.equal(cloud.projects.get(PID)!.branches.has("idea"), false);
  assert.equal((await heads(store)).idea, root);
  // With the writer's go-ahead it restarts from main's latest revision, keeping its own work.
  await write(
    store,
    "idea",
    script("Pilot", scene(""), block("i1", "Bob's idea.")),
    "Idea",
  );
  const asked: unknown[] = [];
  const agreed = await sync({
    hooks: {
      restart: async (question) => {
        asked.push(question);
        return true;
      },
    },
  });
  assert.equal(agreed.ok, true, agreed.error);
  assert.deepEqual(asked, [{ branch: "idea", onto: "main" }]);
  assert.deepEqual(agreed.attention, []);
  assert.deepEqual(agreed.publishedBranches, ["idea"]);
  assert.deepEqual(cloud.log(PID, "idea"), [
    "Idea",
    "Main moved",
    "Create project",
  ]);
  assert.deepEqual(
    cloud.text(PID, "idea").blocks.map((b) => b.text),
    ["INT. MOVED ON", "Bob's idea."],
  );
  assert.deepEqual(await status(store), clean);
});

test("editors publish their own branches; revisions on protected main stay on the device", async (t) => {
  const { cloud, store, sync } = await pulled(t, bob);
  const root = (await heads(store)).main;
  await store.createBranch({
    name: "bobs",
    sourceBranch: "main",
    expectedHead: root,
  });
  await write(store, "bobs", script("Pilot", scene("INT. BOB")), "Bob's scene");
  // The device refuses an editor's commit to main, as the backend would.
  const loaded = await store.loadDraft("main");
  const saved = await store.saveDraft({
    branch: "main",
    baseCommit: root,
    expectedVersion: loaded.version,
    draft: script("Pilot", scene("X")),
  });
  const refused = await store.commit({
    branch: "main",
    expectedHead: root,
    draftVersion: saved.version!,
    message: "No",
    author: { name: "Bob" },
  });
  assert.equal(refused.status, "rejected");
  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.published, { bobs: 1 });
  assert.deepEqual(cloud.log(PID, "bobs"), ["Bob's scene", "Create project"]);
  assert.equal(
    cloud.projects.get(PID)!.commits.get(cloud.head(PID, "bobs"))!.actorUid,
    bob.uid,
  );
  // Demoted to reader while holding an unpublished revision: nothing is sent.
  await write(
    store,
    "bobs",
    script("Pilot", scene("INT. BOB"), block("b2")),
    "More",
  );
  cloud.addMember(PID, bob.uid, "reviewer");
  const asReader = await sync();
  assert.equal(asReader.ok, true);
  assert.deepEqual(asReader.published, {});
  assert.equal((await store.state()).meta.cloud?.role, "reviewer");
  assert.deepEqual(cloud.log(PID, "bobs"), ["Bob's scene", "Create project"]);
});

test("a branch open in the editor is never moved underneath it", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  const mine = await write(
    store,
    "main",
    script("Pilot", scene("INT. MINE")),
    "Mine",
  );
  const draftBefore = await store.loadDraft("main");
  const held = await sync({ hold: "main" });
  assert.equal(held.ok, true, held.error);
  assert.deepEqual(held.attention, [
    { kind: "pending", branch: "main", count: 1 },
  ]);
  assert.equal((await heads(store)).main, mine);
  assert.equal((await store.loadDraft("main")).version, draftBefore.version);
  assert.equal(held.changedLocal, false);
  assert.deepEqual(cloud.log(PID, "main"), ["Create project"]);

  const released = await sync();
  assert.deepEqual(released.published, { main: 1 });
  cloud.webCommit(
    PID,
    alice,
    "main",
    script("Pilot", scene("INT. MINE"), block("w1")),
    "From the web",
  );
  const behind = await sync({ hold: () => "main" });
  assert.deepEqual(behind.attention, [
    { kind: "updates", branch: "main", count: 1 },
  ]);
  assert.notEqual((await heads(store)).main, cloud.head(PID, "main"));
  assert.deepEqual(await status(store), {
    revisions: 0,
    branches: 0,
    incoming: 1,
  });
});

test("a sync cut off after the cloud accepted a revision recovers without duplicating it", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  await write(store, "main", script("Pilot", scene("INT. A")), "A");
  await write(store, "main", script("Pilot", scene("INT. A"), block("b")), "B");
  cloud.failing.commit = 1; // the read-back after the first publish fails
  const cut = await sync();
  assert.equal(cut.offline, true);
  assert.equal(cut.ok, false);
  assert.deepEqual(cloud.log(PID, "main"), ["A", "Create project"]);
  const resumed = await sync();
  assert.equal(resumed.ok, true, resumed.error);
  assert.deepEqual(resumed.attention, []);
  assert.deepEqual(resumed.published, { main: 1 });
  assert.deepEqual(cloud.log(PID, "main"), ["B", "A", "Create project"]);
  assert.equal((await heads(store)).main, cloud.head(PID, "main"));
  assert.deepEqual(await status(store), clean);
});

test("writing on the web and on the device at once is merged, asking only about real overlaps", async (t) => {
  const base = script(
    "Pilot",
    scene("INT. HOUSE"),
    block("a1", "One."),
    block("a2", "Two."),
  );
  const { cloud, store, sync } = await pulled(t, alice, (c) =>
    c.webCommit(PID, alice, "main", base, "Base"),
  );
  // Different elements: combined silently.
  await write(
    store,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "One, on the device."),
      block("a2", "Two."),
    ),
  );
  cloud.webDraft(
    PID,
    alice,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "One."),
      block("a2", "Two, on the web."),
    ),
  );
  const quiet = await sync({
    hooks: { resolve: async () => assert.fail("no conflict expected") },
  });
  assert.equal(quiet.ok, true, quiet.error);
  assert.deepEqual(quiet.draftsMerged, ["main"]);
  const combined = ["INT. HOUSE", "One, on the device.", "Two, on the web."];
  assert.deepEqual(
    (await store.loadDraft("main")).draft.blocks.map((b) => b.text),
    combined,
  );
  assert.deepEqual(
    (
      (await cloud.as(alice).loadDraft(PID, "main")).draft as Snapshot
    ).blocks.map((b) => b.text),
    combined,
  );
  // The same element on both sides: held until the writer decides.
  await write(
    store,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "Device again."),
      block("a2", "Two, on the web."),
    ),
  );
  cloud.webDraft(
    PID,
    alice,
    "main",
    script(
      "Pilot",
      scene("INT. HOUSE"),
      block("a1", "Web again."),
      block("a2", "Two, on the web."),
    ),
  );
  const waiting = await sync();
  assert.deepEqual(waiting.attention, [{ kind: "draft", branch: "main" }]);
  assert.equal(
    ((await cloud.as(alice).loadDraft(PID, "main")).draft as Snapshot).blocks[1]
      .text,
    "Web again.",
  );
  assert.equal(
    (await store.loadDraft("main")).draft.blocks[1].text,
    "Device again.",
  );
  const settled = await sync({
    hooks: { resolve: async () => ({ "block:a1": "source" as const }) },
  });
  assert.deepEqual(settled.attention, []);
  assert.equal(
    (await store.loadDraft("main")).draft.blocks[1].text,
    "Web again.",
  );
});

test("revisions with no recorded author name sync through a mapped id", async (t) => {
  const { cloud, store, sync, api } = await pulled(t, alice, (c) => {
    c.legacyAuthors = true;
    c.createProject(
      PID,
      { ...alice, name: "A Name Nobody Remembers" },
      "Pilot",
    );
    c.projects.get(PID)!.members.set(alice.uid, "owner");
    c.webCommit(
      PID,
      { ...alice, name: "A Name Nobody Remembers" },
      "main",
      script("Pilot", scene("INT. OLD")),
      "Old",
    );
  });
  const { oidMap } = await store.syncState();
  assert.equal(Object.keys(oidMap).length, 2);
  const state = await store.state();
  assert.equal(state.remotes[0].cloudHead, cloud.head(PID, "main"));
  assert.notEqual(state.remotes[0].head, cloud.head(PID, "main"));
  assert.deepEqual(
    (await store.loadDraft("main")).draft,
    cloud.text(PID, "main"),
  );
  cloud.legacyAuthors = false;
  await write(store, "main", script("Pilot", scene("INT. NEW")), "New");
  const report = await sync();
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.published, { main: 1 });
  assert.deepEqual(cloud.log(PID, "main"), ["New", "Old", "Create project"]);
  assert.deepEqual(await status(store), clean);
  assert.equal(
    (await api.loadDraft(PID, "main")).head,
    cloud.head(PID, "main"),
  );
  assert.equal((await sync()).changedLocal, false);
});

test("losing access marks the copy read-only; the project is renamed for everyone on sync", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  await store.setMeta({
    title: "Pilot: Renamed Offline",
    cloud: { pendingTitle: "Pilot: Renamed Offline" },
  });
  assert.equal((await sync()).ok, true);
  assert.equal(cloud.projects.get(PID)!.title, "Pilot: Renamed Offline");
  assert.equal((await store.state()).meta.cloud?.pendingTitle, undefined);
  cloud.projects.get(PID)!.title = "Renamed On The Web";
  await sync();
  assert.equal((await store.state()).meta.title, "Renamed On The Web");

  cloud.removeMember(PID, alice.uid);
  const report = await sync();
  assert.deepEqual([report.ok, report.access], [false, "revoked"]);
  assert.equal((await store.state()).meta.cloud?.access, "revoked");
  const draft = await store.loadDraft("main");
  assert.equal(
    (
      await store.saveDraft({
        branch: "main",
        baseCommit: draft.baseCommit,
        expectedVersion: draft.version,
        draft: draft.draft,
      })
    ).status,
    "rejected",
  );
  assert.ok((await store.readSnapshot(draft.head)).blocks.length);
});

test("being offline changes nothing and is reported as such", async (t) => {
  const { cloud, store, sync } = await pulled(t);
  const mine = await write(
    store,
    "main",
    script("Pilot", scene("INT. OFFLINE")),
    "Offline",
  );
  cloud.failing.access = 1;
  const report = await sync();
  assert.deepEqual(
    [report.ok, report.offline, report.error],
    [false, true, undefined],
  );
  assert.equal((await heads(store)).main, mine);
});
