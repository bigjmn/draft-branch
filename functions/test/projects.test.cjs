const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { ProjectService } = require("../lib/projects/service");
const { hash, blankSnapshot } = require("../lib/projects/model");
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled
  ? initializeApp({ projectId: "demo-draftbranch" }, "backend-tests")
  : null;
const db = app ? getFirestore(app) : null;
after(async () => {
  if (app) await deleteApp(app);
});
class MemoryObjects {
  data = new Map();
  async put(path, bytes) {
    if (this.data.has(path)) assert.deepEqual(this.data.get(path), bytes);
    this.data.set(path, Buffer.from(bytes));
  }
  async get(path) {
    if (!this.data.has(path)) throw new Error("Object missing");
    return this.data.get(path);
  }
}
const actor = (uid) => ({
  uid,
  name: uid,
  email: uid + "@example.com",
  emailVerified: true,
});
const alice = actor("alice"),
  bob = actor("bob"),
  eve = actor("eve");
function fixture() {
  const objects = new MemoryObjects();
  return { objects, s: new ProjectService(db, objects) };
}
const unique = () => require("node:crypto").randomUUID();
async function prepare(
  s,
  objects,
  a,
  pid,
  branch,
  head,
  version,
  draft,
  key = unique(),
) {
  const bytes = Buffer.from(JSON.stringify(draft));
  const ticket = await s.beginDraftUpload(a, {
    projectId: pid,
    branchId: branch,
    baseCommit: head,
    expectedVersion: version,
    contentHash: hash(bytes),
    requestId: key,
  });
  await objects.put(ticket.path, bytes);
  return ticket;
}
async function save(s, objects, a, pid, branch, head, version, draft) {
  const ticket = await prepare(
    s,
    objects,
    a,
    pid,
    branch,
    head,
    version,
    draft,
  );
  await s.finalizeUpload(
    ticket.path,
    "1",
    objects.data.get(ticket.path).length,
    "application/json",
  );
  return (
    await db.doc(`projects/${pid}/uploads/${ticket.uploadId}`).get()
  ).data();
}
const queue = (s, a, pid, branch, head, version, key = unique()) =>
  s.commitDraft(a, {
    projectId: pid,
    branchId: branch,
    expectedHead: head,
    draftVersion: version,
    message: "Add scenes",
    requestId: key,
  });

test(
  "project → save → commit → invite editor → branch → commit; defaults remain private",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      requestId = unique();
    const project = await s.createProject(alice, { title: "Pilot", requestId });
    assert.deepEqual(
      await s.createProject(alice, { title: "Pilot", requestId }),
      project,
    );
    await assert.rejects(
      s.createProject(alice, { title: "Changed", requestId }),
      { code: "already-exists" },
    );
    const pid = project.projectId;
    assert.equal(
      (await db.doc(`projects/${pid}`).get()).data().visibility,
      "private",
    );
    await assert.rejects(
      s.loadDraft(eve, { projectId: pid, branchId: "main" }),
      { code: "permission-denied" },
    );
    const draft = {
      title: "Pilot",
      blocks: [
        { id: "s1", type: "scene", text: "EXT. ROAD - DAY" },
        { id: "a1", type: "action", text: "A car arrives." },
      ],
    };
    assert.equal(
      (await save(s, objects, alice, pid, "main", project.head, 0, draft))
        .status,
      "accepted",
    );
    const job = await queue(s, alice, pid, "main", project.head, 1);
    await Promise.all([
      s.processCommit(pid, job.operationId),
      s.processCommit(pid, job.operationId),
    ]);
    const result = (
      await db.doc(`projects/${pid}/operations/${job.operationId}`).get()
    ).data();
    assert.equal(result.status, "succeeded");
    assert.deepEqual(
      (
        await s.readRevision(alice, {
          projectId: pid,
          commitId: result.commitId,
        })
      ).draft.blocks,
      draft.blocks,
    );
    const invite = await s.inviteMember(alice, {
      projectId: pid,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    await assert.rejects(s.acceptInvitation(eve, invite), {
      code: "permission-denied",
    });
    await assert.rejects(
      s.acceptInvitation({ ...bob, emailVerified: false }, invite),
      { code: "failed-precondition" },
    );
    assert.equal((await s.acceptInvitation(bob, invite)).role, "editor");
    assert.equal((await s.acceptInvitation(bob, invite)).role, "editor");
    await s.createBranch(bob, {
      projectId: pid,
      name: "alternate-ending",
      sourceBranch: "main",
      expectedHead: result.commitId,
      requestId: unique(),
    });
    const bobDraft = {
      ...draft,
      blocks: [
        ...draft.blocks,
        { id: "s2", type: "scene", text: "INT. STATION - NIGHT" },
      ],
    };
    assert.equal(
      (
        await save(
          s,
          objects,
          bob,
          pid,
          "alternate-ending",
          result.commitId,
          0,
          bobDraft,
        )
      ).status,
      "accepted",
    );
    const bobJob = await queue(
      s,
      bob,
      pid,
      "alternate-ending",
      result.commitId,
      1,
    );
    await s.processCommit(pid, bobJob.operationId);
    const bobResult = (
      await db.doc(`projects/${pid}/operations/${bobJob.operationId}`).get()
    ).data();
    assert.equal(bobResult.status, "succeeded");
    assert.notEqual(bobResult.commitId, result.commitId);
    assert.equal(
      (await db.doc(`projects/${pid}/branches/main`).get()).data().head,
      result.commitId,
    );
    assert.equal(
      (
        await db.doc(`projects/${pid}/commits/${bobResult.commitId}`).get()
      ).data().parent[0],
      result.commitId,
    );
    await assert.rejects(queue(s, bob, pid, "main", result.commitId, 0), {
      code: "permission-denied",
    });
  },
);

test(
  "two uploads at the same version: one accepted; duplicate event does not advance again",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      p = await s.createProject(alice, { title: "Race", requestId: unique() });
    const a = await prepare(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      0,
      blankSnapshot("A"),
    );
    const b = await prepare(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      0,
      blankSnapshot("B"),
    );
    await Promise.all(
      [a, b].map((t) => s.finalizeUpload(t.path, "1", 100, "application/json")),
    );
    const statuses = await Promise.all(
      [a, b].map(
        async (t) =>
          (
            await db.doc(`projects/${p.projectId}/uploads/${t.uploadId}`).get()
          ).data().status,
      ),
    );
    assert.deepEqual(statuses.sort(), ["accepted", "conflict"]);
    await s.finalizeUpload(a.path, "1", 100, "application/json");
    assert.equal(
      (await s.loadDraft(alice, { projectId: p.projectId, branchId: "main" }))
        .version,
      1,
    );
  },
);

test(
  "concurrent commits cannot overwrite a branch; successful requests replay idempotently",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      p = await s.createProject(alice, {
        title: "Commit race",
        requestId: unique(),
      });
    await save(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      0,
      blankSnapshot("Saved"),
    );
    const key = unique(),
      a = await queue(s, alice, p.projectId, "main", p.head, 1, key),
      b = await queue(s, alice, p.projectId, "main", p.head, 1);
    await Promise.all([
      s.processCommit(p.projectId, a.operationId),
      s.processCommit(p.projectId, b.operationId),
    ]);
    const statuses = await Promise.all(
      [a, b].map(
        async (j) =>
          (
            await db
              .doc(`projects/${p.projectId}/operations/${j.operationId}`)
              .get()
          ).data().status,
      ),
    );
    assert.deepEqual(statuses.sort(), ["conflict", "succeeded"]);
    assert.equal(
      (await queue(s, alice, p.projectId, "main", p.head, 1, key)).operationId,
      a.operationId,
    );
  },
);

test(
  "revoked access blocks queued commits, pending uploads, reads and invitation replay",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      p = await s.createProject(alice, {
        title: "Revocation",
        requestId: unique(),
      });
    const invite = await s.inviteMember(alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    await s.acceptInvitation(bob, invite);
    await s.createBranch(bob, {
      projectId: p.projectId,
      name: "bob-version",
      sourceBranch: "main",
      expectedHead: p.head,
      requestId: unique(),
    });
    await save(
      s,
      objects,
      bob,
      p.projectId,
      "bob-version",
      p.head,
      0,
      blankSnapshot("Bob"),
    );
    const job = await queue(s, bob, p.projectId, "bob-version", p.head, 1);
    const pending = await prepare(
      s,
      objects,
      bob,
      p.projectId,
      "bob-version",
      p.head,
      1,
      blankSnapshot("More"),
    );
    await s.removeMember(alice, { projectId: p.projectId, uid: bob.uid });
    await s.processCommit(p.projectId, job.operationId);
    await s.finalizeUpload(pending.path, "1", 100, "application/json");
    assert.equal(
      (
        await db
          .doc(`projects/${p.projectId}/operations/${job.operationId}`)
          .get()
      ).data().status,
      "rejected",
    );
    assert.equal(
      (
        await db
          .doc(`projects/${p.projectId}/uploads/${pending.uploadId}`)
          .get()
      ).data().status,
      "rejected",
    );
    await assert.rejects(
      s.loadDraft(bob, { projectId: p.projectId, branchId: "bob-version" }),
      { code: "permission-denied" },
    );
    await assert.rejects(s.acceptInvitation(bob, invite), {
      code: "failed-precondition",
    });
  },
);

test(
  "bad uploads and expired invitations never become accepted state",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      p = await s.createProject(alice, {
        title: "Validation",
        requestId: unique(),
      });
    const ticket = await prepare(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      0,
      { title: "Bad", blocks: [] },
    );
    await s.finalizeUpload(ticket.path, "1", 100, "application/json");
    assert.equal(
      (
        await db.doc(`projects/${p.projectId}/uploads/${ticket.uploadId}`).get()
      ).data().status,
      "rejected",
    );
    const invite = await s.inviteMember(alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    await db
      .doc(`projects/${p.projectId}/invitations/${invite.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(0) });
    await assert.rejects(s.acceptInvitation(bob, invite), {
      code: "failed-precondition",
    });
  },
);

test(
  "newer autosaves are not rebased by an older queued commit",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture(),
      p = await s.createProject(alice, {
        title: "In-flight save",
        requestId: unique(),
      });
    await save(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      0,
      blankSnapshot("Old"),
    );
    const job = await queue(s, alice, p.projectId, "main", p.head, 1);
    await save(
      s,
      objects,
      alice,
      p.projectId,
      "main",
      p.head,
      1,
      blankSnapshot("Newer"),
    );
    await s.processCommit(p.projectId, job.operationId);
    const loaded = await s.loadDraft(alice, {
      projectId: p.projectId,
      branchId: "main",
    });
    assert.equal(loaded.draft.title, "Newer");
    assert.equal(loaded.baseCommit, p.head);
    assert.equal(loaded.version, 2);
    assert.notEqual(loaded.head, p.head);
  },
);
