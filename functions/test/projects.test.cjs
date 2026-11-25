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
async function inviteWithToken(s, a, data) {
  const result = await s.inviteMember(a, data);
  const mail = (
    await db
      .doc(`invitationMail/${hash(`${data.projectId}:${result.invitationId}`)}`)
      .get()
  ).data();
  return {
    ...result,
    token: new URLSearchParams(new URL(mail.link).hash.slice(1)).get("token"),
  };
}
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
    const invite = await inviteWithToken(s, alice, {
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
    const invite = await inviteWithToken(s, alice, {
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
    const invite = await inviteWithToken(s, alice, {
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

test(
  "guest capability reads the committed tree but not working drafts; tokens remain scoped and revocable",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const p = await s.createProject(alice, {
      title: "Shared script",
      requestId: unique(),
    });
    const invite = await inviteWithToken(s, alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    const draft = blankSnapshot("Unpublished secret");
    draft.blocks[0].text = "INT. PRIVATE ROOM - NIGHT";
    await save(s, objects, alice, p.projectId, "main", p.head, 0, draft);
    const read = await s.sharedInvitation(invite, true);
    await s.createBranch(alice, {
      projectId: p.projectId,
      name: "alternate",
      sourceBranch: "main",
      expectedHead: p.head,
      requestId: unique(),
    });
    const alternate = blankSnapshot("Alternate ending");
    alternate.blocks[0].text = "INT. TRAIN - DAY";
    const saved = await save(
      s,
      objects,
      alice,
      p.projectId,
      "alternate",
      p.head,
      0,
      alternate,
    );
    const job = await queue(
      s,
      alice,
      p.projectId,
      "alternate",
      p.head,
      saved.version,
    );
    await s.processCommit(p.projectId, job.operationId);
    const alternateRead = await s.sharedInvitation(
      { ...invite, branchId: "alternate" },
      true,
    );
    assert.equal(alternateRead.draft.title, "Alternate ending");
    assert.deepEqual(alternateRead.branches.map((b) => b.name).sort(), [
      "alternate",
      "main",
    ]);
    const history = await s.sharedInvitation(
      { ...invite, commitId: alternateRead.commitId, history: true },
      true,
    );
    assert.equal(history.history.length, 2);
    assert.equal(history.history[1].oid, p.head);
    assert.equal(
      (await s.sharedInvitation({ ...invite, commitId: p.head }, true)).draft
        .title,
      "Shared script",
    );
    await assert.rejects(
      s.sharedInvitation({ ...invite, branchId: "missing" }, true),
      { code: "not-found" },
    );
    await assert.rejects(
      s.sharedInvitation({ ...invite, commitId: "fake" }, true),
      { code: "invalid-argument" },
    );
    assert.equal(read.draft.title, "Shared script");
    assert.equal(read.draft.blocks[0].text, "");
    assert.equal(read.role, "editor");
    assert.equal("email" in read, false);
    const stored = (
      await db
        .doc(`projects/${p.projectId}/invitations/${invite.invitationId}`)
        .get()
    ).data();
    assert.equal(stored.tokenHash, hash(invite.token));
    assert.equal(JSON.stringify(stored).includes(invite.token), false);
    await assert.rejects(
      s.sharedInvitation({ ...invite, token: "0".repeat(64) }, true),
      { code: "permission-denied" },
    );
    await assert.rejects(
      s.acceptInvitation(bob, { ...invite, token: undefined }),
      { code: "permission-denied" },
    );
    const other = await s.createProject(alice, {
      title: "Other",
      requestId: unique(),
    });
    await assert.rejects(
      s.sharedInvitation({ ...invite, projectId: other.projectId }, true),
      { code: "permission-denied" },
    );
    await assert.rejects(
      s.sharedInvitation({ ...invite, commitId: other.head }, true),
      { code: "not-found" },
    );
    await s.acceptInvitation(bob, invite);
    await s.revokeInvitation(alice, invite);
    await assert.rejects(s.sharedInvitation(invite, true), {
      code: "permission-denied",
    });
    // Revoking guest capability does not silently remove an accepted member.
    assert.equal(
      (await s.loadDraft(bob, { projectId: p.projectId, branchId: "main" }))
        .draft.title,
      "Shared script",
    );
  },
);

test(
  "readers cannot branch, upload or commit; owner changes roles and removal revokes accepted links",
  { skip: !enabled },
  async () => {
    const { s } = fixture();
    const p = await s.createProject(alice, {
      title: "Permissions",
      requestId: unique(),
    });
    const invite = await inviteWithToken(s, alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "reviewer",
      requestId: unique(),
    });
    await s.acceptInvitation(bob, invite);
    await assert.rejects(
      s.createBranch(bob, {
        projectId: p.projectId,
        name: "alternate",
        sourceBranch: "main",
        expectedHead: p.head,
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    await assert.rejects(
      s.beginDraftUpload(bob, {
        projectId: p.projectId,
        branchId: "main",
        baseCommit: p.head,
        expectedVersion: 0,
        contentHash: "0".repeat(64),
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    await assert.rejects(queue(s, bob, p.projectId, "main", p.head, 0), {
      code: "permission-denied",
    });
    await assert.rejects(
      s.updateMemberRole(bob, {
        projectId: p.projectId,
        uid: bob.uid,
        role: "editor",
      }),
      { code: "permission-denied" },
    );
    await s.updateMemberRole(alice, {
      projectId: p.projectId,
      uid: bob.uid,
      role: "editor",
    });
    await s.createBranch(bob, {
      projectId: p.projectId,
      name: "alternate",
      sourceBranch: "main",
      expectedHead: p.head,
      requestId: unique(),
    });
    await s.removeMember(alice, { projectId: p.projectId, uid: bob.uid });
    await assert.rejects(s.sharedInvitation(invite, true), {
      code: "permission-denied",
    });
    await assert.rejects(s.acceptInvitation(bob, invite), {
      code: "failed-precondition",
    });
  },
);

test(
  "expired links and nonowner invitations are denied",
  { skip: !enabled },
  async () => {
    const { s } = fixture();
    const p = await s.createProject(alice, {
      title: "Expiry",
      requestId: unique(),
    });
    await assert.rejects(
      s.inviteMember(eve, {
        projectId: p.projectId,
        email: bob.email,
        role: "editor",
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    const invite = await inviteWithToken(s, alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "reviewer",
      requestId: unique(),
    });
    await db
      .doc(`projects/${p.projectId}/invitations/${invite.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    await assert.rejects(s.sharedInvitation(invite, true), {
      code: "permission-denied",
    });
  },
);

test(
  "invitation retries do not duplicate emails; successful worker deletes bearer link and skips replay",
  { skip: !enabled },
  async () => {
    const { deliverInvitation } = require("../lib/projects/mail");
    const { s } = fixture();
    const p = await s.createProject(alice, {
      title: "Email",
      requestId: unique(),
    });
    const input = {
      projectId: p.projectId,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    };
    const first = await s.inviteMember(alice, input),
      second = await s.inviteMember(alice, input);
    assert.equal(first.invitationId, second.invitationId);
    const mailId = hash(`${p.projectId}:${first.invitationId}`);
    let sent = 0;
    const send = async (message) => {
      sent++;
      assert.equal(message.to, bob.email);
      assert.match(message.text, /#token=[0-9a-f]{64}/);
      assert.match(message.text, /read-only/);
    };
    await deliverInvitation(db, mailId, send);
    await deliverInvitation(db, mailId, send);
    assert.equal(sent, 1);
    assert.equal(
      (await db.doc(`invitationMail/${mailId}`).get()).data().link,
      undefined,
    );
    assert.equal(
      (
        await db
          .doc(`projects/${p.projectId}/invitations/${first.invitationId}`)
          .get()
      ).data().deliveryStatus,
      "sent",
    );
  },
);

test(
  "email worker retries safely and stops after bounded failures; revoked invitations never send",
  { skip: !enabled },
  async () => {
    const { deliverInvitation } = require("../lib/projects/mail");
    const { s } = fixture();
    const p = await s.createProject(alice, {
      title: "Retry",
      requestId: unique(),
    });
    const invite = await s.inviteMember(alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "reviewer",
      requestId: unique(),
    });
    const mailId = hash(`${p.projectId}:${invite.invitationId}`);
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        deliverInvitation(db, mailId, async () => {
          throw new Error("sensitive provider response");
        }),
        { message: "Invitation email delivery failed." },
      );
    await deliverInvitation(db, mailId, async () => {
      assert.fail("should stop retrying");
    });
    const job = (await db.doc(`invitationMail/${mailId}`).get()).data();
    assert.equal(job.status, "failed");
    assert.equal(job.link, undefined);
    const revoked = await s.inviteMember(alice, {
      projectId: p.projectId,
      email: bob.email,
      role: "reviewer",
      requestId: unique(),
    });
    await s.revokeInvitation(alice, revoked);
    await deliverInvitation(
      db,
      hash(`${p.projectId}:${revoked.invitationId}`),
      async () => {
        assert.fail("revoked email must not send");
      },
    );
  },
);

/** Save `draft` on `branch` and commit it; returns the new head. */
async function commitOn(s, objects, a, pid, branch, draft) {
  const loaded = await s.loadDraft(a, { projectId: pid, branchId: branch });
  const saved = await save(
    s,
    objects,
    a,
    pid,
    branch,
    loaded.baseCommit,
    loaded.version,
    draft,
  );
  assert.equal(saved.status, "accepted");
  const job = await queue(s, a, pid, branch, loaded.head, saved.version);
  await s.processCommit(pid, job.operationId);
  const done = (
    await db.doc(`projects/${pid}/operations/${job.operationId}`).get()
  ).data();
  assert.equal(done.status, "succeeded", done.error);
  return done.commitId;
}

test(
  "merge requests: editors propose, only the owner merges into main; conflicts must be resolved",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const { projectId: pid } = await s.createProject(alice, {
      title: "Merge",
      requestId: unique(),
    });
    const scene = (text) => ({ id: "s1", type: "scene", text });
    const action = (text) => ({ id: "a1", type: "action", text });
    const start = await commitOn(s, objects, alice, pid, "main", {
      title: "Merge",
      blocks: [scene("INT. HOUSE - DAY"), action("Quiet.")],
    });
    const invite = await inviteWithToken(s, alice, {
      projectId: pid,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    await s.acceptInvitation(bob, invite);
    await s.createBranch(bob, {
      projectId: pid,
      name: "rewrite",
      sourceBranch: "main",
      expectedHead: start,
      requestId: unique(),
    });
    const branchHead = await commitOn(s, objects, bob, pid, "rewrite", {
      title: "Merge",
      blocks: [
        scene("INT. HOUSE - DAY"),
        action("Thunder."),
        { id: "s2", type: "scene", text: "EXT. GARDEN - NIGHT" },
      ],
    });
    const mainHead = await commitOn(s, objects, alice, pid, "main", {
      title: "Merge (draft 2)",
      blocks: [scene("INT. HOUSE - DAY"), action("Rain.")],
    });
    // Alice's clean working draft follows main after her own commit.
    const reload = await s.loadDraft(alice, {
      projectId: pid,
      branchId: "main",
    });
    assert.equal(reload.baseCommit, mainHead);

    const preview = await s.previewMerge(bob, {
      projectId: pid,
      sourceBranch: "rewrite",
      targetBranch: "main",
    });
    assert.equal(preview.baseCommit, start);
    assert.equal(preview.upToDate, false);

    const request = await s.openMergeRequest(bob, {
      projectId: pid,
      sourceBranch: "rewrite",
      targetBranch: "main",
      title: "Storm rewrite",
      requestId: unique(),
    });
    await assert.rejects(
      s.openMergeRequest(bob, {
        projectId: pid,
        sourceBranch: "rewrite",
        targetBranch: "main",
        title: "Again",
        requestId: unique(),
      }),
      { code: "already-exists" },
    );
    const mergeInput = {
      projectId: pid,
      sourceBranch: "rewrite",
      targetBranch: "main",
      expectedSourceHead: branchHead,
      expectedTargetHead: mainHead,
      mergeRequestId: request.mergeRequestId,
    };
    // Editors cannot approve merges into protected main.
    await assert.rejects(
      s.mergeBranches(bob, {
        ...mergeInput,
        resolutions: { "block:a1": "source" },
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    // Both edited a1: the owner must choose.
    await assert.rejects(
      s.mergeBranches(alice, { ...mergeInput, requestId: unique() }),
      { code: "failed-precondition" },
    );
    await assert.rejects(
      s.mergeBranches(alice, {
        ...mergeInput,
        expectedTargetHead: start,
        resolutions: { "block:a1": "source" },
        requestId: unique(),
      }),
      { code: "aborted" },
    );
    const key = unique();
    const merged = await s.mergeBranches(alice, {
      ...mergeInput,
      resolutions: { "block:a1": { text: "Rain, then thunder." } },
      requestId: key,
    });
    assert.deepEqual(
      await s.mergeBranches(alice, {
        ...mergeInput,
        resolutions: { "block:a1": { text: "Rain, then thunder." } },
        requestId: key,
      }),
      merged,
    );
    const commit = (
      await db.doc(`projects/${pid}/commits/${merged.commitId}`).get()
    ).data();
    assert.deepEqual(commit.parent, [mainHead, branchHead]);
    assert.equal(commit.merge.sourceBranch, "rewrite");
    assert.equal(commit.authorName, "alice");
    assert.equal(
      (await db.doc(`projects/${pid}/branches/main`).get()).data().head,
      merged.commitId,
    );
    const result = await s.readRevision(alice, {
      projectId: pid,
      commitId: merged.commitId,
    });
    assert.equal(result.draft.title, "Merge (draft 2)");
    assert.deepEqual(
      result.draft.blocks.map((b) => b.text),
      ["INT. HOUSE - DAY", "Rain, then thunder.", "EXT. GARDEN - NIGHT"],
    );
    assert.equal(
      (
        await db
          .doc(`projects/${pid}/mergeRequests/${request.mergeRequestId}`)
          .get()
      ).data().status,
      "merged",
    );
    // Nothing left to merge.
    await assert.rejects(
      s.mergeBranches(alice, {
        ...mergeInput,
        expectedTargetHead: merged.commitId,
        requestId: unique(),
      }),
      { code: "failed-precondition" },
    );
    // Editors may merge main back into their own unprotected branch.
    const back = await s.mergeBranches(bob, {
      projectId: pid,
      sourceBranch: "main",
      targetBranch: "rewrite",
      expectedSourceHead: merged.commitId,
      expectedTargetHead: branchHead,
      requestId: unique(),
    });
    assert.equal(
      (await db.doc(`projects/${pid}/branches/rewrite`).get()).data().head,
      back.commitId,
    );
    // Bob's clean draft on rewrite follows the new head.
    assert.equal(
      (await s.loadDraft(bob, { projectId: pid, branchId: "rewrite" }))
        .baseCommit,
      back.commitId,
    );
  },
);

test(
  "only the author or owner closes a merge request",
  { skip: !enabled },
  async () => {
    const { s } = fixture();
    const { projectId: pid, head } = await s.createProject(alice, {
      title: "Close",
      requestId: unique(),
    });
    const invite = await inviteWithToken(s, alice, {
      projectId: pid,
      email: bob.email,
      role: "editor",
      requestId: unique(),
    });
    await s.acceptInvitation(bob, invite);
    await s.createBranch(alice, {
      projectId: pid,
      name: "idea",
      sourceBranch: "main",
      expectedHead: head,
      requestId: unique(),
    });
    const request = await s.openMergeRequest(alice, {
      projectId: pid,
      sourceBranch: "idea",
      targetBranch: "main",
      title: "Idea",
      requestId: unique(),
    });
    await assert.rejects(
      s.closeMergeRequest(bob, {
        projectId: pid,
        mergeRequestId: request.mergeRequestId,
      }),
      { code: "permission-denied" },
    );
    await s.closeMergeRequest(alice, {
      projectId: pid,
      mergeRequestId: request.mergeRequestId,
    });
    assert.equal(
      (
        await db
          .doc(`projects/${pid}/mergeRequests/${request.mergeRequestId}`)
          .get()
      ).data().status,
      "closed",
    );
  },
);

 test("imported project starts with its validated screenplay and retries safely", { skip: !enabled }, async () => {
 const { s } = fixture(); const requestId = unique();
 const draft = { title: "Original", blocks: [{ id: "scene-1", type: "scene", text: "INT. HOUSE - DAY" }] };
 const input = { requestId, title: "Imported", draft };
 const project = await s.createProject(alice, input);
 assert.deepEqual(await s.createProject(alice, input), project);
 const loaded = await s.loadDraft(alice, { projectId: project.projectId, branchId: "main" });
 assert.equal(loaded.draft.title, "Imported"); assert.deepEqual(loaded.draft.blocks, draft.blocks);
 await assert.rejects(() => s.createProject(alice, { ...input, draft: { ...draft, blocks: [] } }));
 await assert.rejects(() => s.createProject(alice, { ...input, draft: { ...draft, blocks: [{ ...draft.blocks[0], text: "Changed" }] } }));
 });

test('owner renames project metadata and all member dashboard entries; others cannot', {skip: !enabled}, async()=>{
 const {s} = fixture();
 const {projectId} = await s.createProject(alice,{title:'Before',requestId:unique()});
 await db.doc(`projects/${projectId}/members/${bob.uid}`).set({role:'editor'});
 await db.doc(`users/${bob.uid}/projects/${projectId}`).set({projectId,title:'Before',role:'editor'});
 await assert.rejects(()=>s.renameProject(bob,{projectId,title:'Forbidden'}));
 await assert.rejects(()=>s.renameProject(eve,{projectId,title:'Forbidden'}));
 await assert.rejects(()=>s.renameProject(alice,{projectId,title:'   '}));
 await s.renameProject(alice,{projectId,title:'After'});
 for(const path of [`projects/${projectId}`,`users/${alice.uid}/projects/${projectId}`,`users/${bob.uid}/projects/${projectId}`]) assert.equal((await db.doc(path).get()).data().title,'After');
 assert.equal((await db.doc(`users/${bob.uid}/projects/${projectId}`).get()).data().role,'editor');
});

test('owner deletion revokes access, removes all project data and is retry safe', {skip:!enabled}, async()=>{
 const {s,objects}=fixture(); const requestId=unique();
 objects.deletePrefix=async prefix=>{for(const path of objects.data.keys())if(path.startsWith(prefix))objects.data.delete(path);};
 const {projectId}=await s.createProject(alice,{title:'Delete me',requestId});
 await db.doc(`projects/${projectId}/members/${bob.uid}`).set({role:'editor'});
 await db.doc(`users/${bob.uid}/projects/${projectId}`).set({projectId,title:'Delete me',role:'editor'});
 await db.doc(`projects/${projectId}/comments/note`).set({text:'A note'});
 await db.doc(`invitationMail/delete-${projectId}`).set({projectId,to:'test@example.com'});
 await assert.rejects(()=>s.deleteProject(bob,{projectId,confirmTitle:'Delete me'}));
 await assert.rejects(()=>s.deleteProject(alice,{projectId,confirmTitle:'Wrong title'}));
 await s.deleteProject(alice,{projectId,confirmTitle:'Delete me'});
 await assert.rejects(()=>s.loadDraft(alice,{projectId,branchId:'main'}));
 assert.equal((await db.doc(`users/${bob.uid}/projects/${projectId}`).get()).exists,false);
 assert.equal((await db.doc(`users/${alice.uid}/projects/${projectId}`).get()).exists,false);
 assert.equal((await s.deleteProject(alice,{projectId,confirmTitle:'Delete me'})).status,'queued');
 await s.processDeletion(projectId);
 assert.equal((await db.doc(`projects/${projectId}`).get()).exists,false);
 assert.equal((await db.doc(`projects/${projectId}/comments/note`).get()).exists,false);
 assert.equal((await db.doc(`invitationMail/delete-${projectId}`).get()).exists,false);
 assert.equal([...objects.data.keys()].some(path=>path.startsWith(`projects/${projectId}/`)),false);
 await s.processDeletion(projectId);
 assert.equal((await s.deleteProject(alice,{projectId,confirmTitle:'Delete me'})).status,'complete');
 await assert.rejects(()=>s.createProject(alice,{title:'Delete me',requestId}));
 await assert.rejects(()=>s.deleteProject(eve,{projectId,confirmTitle:'Delete me'}));
});

// ---- Editor options, dedicated branches, commenters ------------------------
const carol = actor("carol"),
  dave = actor("dave");
async function join(s, owner, pid, who, options) {
  const invite = await inviteWithToken(s, owner, {
    projectId: pid,
    email: who.email,
    requestId: unique(),
    ...options,
  });
  return { invite, accepted: await s.acceptInvitation(who, invite) };
}
const tryEdit = (s, objects, a, pid, branch, head, draft) =>
  prepare(s, objects, a, pid, branch, head, 0, draft);
const page = (text) => ({
  title: "Options",
  blocks: [
    { id: "s1", type: "scene", text: "INT. ROOM - DAY" },
    { id: "a1", type: "action", text },
  ],
});

test(
  "editors can't edit main unless invited to; those who can also merge into it",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const { projectId: pid } = await s.createProject(alice, {
      title: "Options",
      requestId: unique(),
    });
    const start = await commitOn(s, objects, alice, pid, "main", page("One."));
    await join(s, alice, pid, bob, { role: "editor" });
    const bobMember = (
      await db.doc(`projects/${pid}/members/bob`).get()
    ).data();
    assert.deepEqual(bobMember.access, {
      editMain: false,
      commentMain: true,
      branch: null,
    });
    await assert.rejects(
      tryEdit(s, objects, bob, pid, "main", start, page("Bob on main.")),
      { code: "permission-denied" },
    );
    // Bob reads main's latest revision, never a working draft there.
    assert.equal(
      (await s.loadDraft(bob, { projectId: pid, branchId: "main" })).version,
      0,
    );
    await s.createBranch(bob, {
      projectId: pid,
      name: "bob-idea",
      sourceBranch: "main",
      expectedHead: start,
      requestId: unique(),
    });
    await commitOn(s, objects, bob, pid, "bob-idea", page("Bob's idea."));
    const merge = async (who) => {
      const preview = await s.previewMerge(who, {
        projectId: pid,
        sourceBranch: "bob-idea",
        targetBranch: "main",
      });
      return s.mergeBranches(who, {
        projectId: pid,
        sourceBranch: "bob-idea",
        targetBranch: "main",
        expectedSourceHead: preview.sourceHead,
        expectedTargetHead: preview.targetHead,
        requestId: unique(),
      });
    };
    await assert.rejects(merge(bob), { code: "permission-denied" });

    // Carol may edit main: she commits there and merges Bob's branch in.
    await join(s, alice, pid, carol, { role: "editor", editMain: true });
    await commitOn(s, objects, carol, pid, "main", {
      ...page("One."),
      blocks: [
        ...page("One.").blocks,
        { id: "c1", type: "action", text: "Carol adds a line on main." },
      ],
    });
    const result = await merge(carol);
    assert.equal(
      (await db.doc(`projects/${pid}/branches/main`).get()).data().head,
      result.commitId,
    );
  },
);

test(
  "a dedicated branch is made on joining, carries main's comments, and is the editor's only writable branch",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const { projectId: pid } = await s.createProject(alice, {
      title: "Options",
      requestId: unique(),
    });
    const start = await commitOn(s, objects, alice, pid, "main", page("One."));
    await db.doc(`projects/${pid}/comments/note-1`).set({
      authorUid: "alice",
      authorName: "Alice",
      branch: "main",
      blockId: "a1",
      quote: "One.",
      text: "Punch this up.",
      resolved: false,
      createdAt: Timestamp.fromMillis(Date.now()),
    });
    // Invalid combinations are refused up front.
    for (const [options, code] of [
      [{ branch: "bob-pages", editMain: true }, "invalid-argument"],
      [{ branch: "main" }, "invalid-argument"],
      [{ branch: "Bad Name" }, "invalid-argument"],
      [{ note: "x".repeat(1001) }, "invalid-argument"],
    ])
      await assert.rejects(
        s.inviteMember(alice, {
          projectId: pid,
          email: bob.email,
          role: "editor",
          requestId: unique(),
          ...options,
        }),
        { code },
      );
    const { invite, accepted } = await join(s, alice, pid, bob, {
      role: "editor",
      branch: "bob-pages",
      note: "Take a pass at act two.",
    });
    assert.deepEqual(accepted, {
      projectId: pid,
      role: "editor",
      branch: "bob-pages",
    });
    // Accepting again changes nothing and still points at the branch.
    assert.equal((await s.acceptInvitation(bob, invite)).branch, "bob-pages");
    const info = await s.sharedInvitation(invite);
    assert.equal(info.note, "Take a pass at act two.");
    assert.equal(info.access.branch, "bob-pages");
    const mail = (
      await db
        .collection("invitationMail")
        .where("invitationId", "==", invite.invitationId)
        .get()
    ).docs[0].data();
    assert.equal(mail.branch, "bob-pages");
    assert.equal(mail.note, "Take a pass at act two.");

    const branch = (
      await db.doc(`projects/${pid}/branches/bob-pages`).get()
    ).data();
    assert.equal(branch.head, start);
    assert.equal(branch.dedicatedTo, "bob");
    assert.equal(branch.protected, false);
    const copied = (
      await db
        .collection(`projects/${pid}/comments`)
        .where("branch", "==", "bob-pages")
        .get()
    ).docs.map((d) => d.data());
    assert.equal(copied.length, 1);
    assert.equal(copied[0].text, "Punch this up.");
    assert.equal(copied[0].copiedFrom, "note-1");

    // The name is taken now, so another invitation can't reuse it.
    await assert.rejects(
      s.inviteMember(alice, {
        projectId: pid,
        email: dave.email,
        role: "editor",
        branch: "bob-pages",
        requestId: unique(),
      }),
      { code: "already-exists" },
    );

    await commitOn(s, objects, bob, pid, "bob-pages", page("Bob's pass."));
    // Other branches are view-only for Bob, and he branches only from his own.
    await s.createBranch(alice, {
      projectId: pid,
      name: "alice-draft",
      sourceBranch: "main",
      expectedHead: start,
      requestId: unique(),
    });
    await assert.rejects(
      tryEdit(s, objects, bob, pid, "alice-draft", start, page("No.")),
      { code: "permission-denied" },
    );
    await assert.rejects(
      s.createBranch(bob, {
        projectId: pid,
        name: "from-main",
        sourceBranch: "main",
        expectedHead: start,
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    const pagesHead = (
      await db.doc(`projects/${pid}/branches/bob-pages`).get()
    ).data().head;
    await s.createBranch(bob, {
      projectId: pid,
      name: "bob-sub",
      sourceBranch: "bob-pages",
      expectedHead: pagesHead,
      requestId: unique(),
    });
    assert.equal(
      (
        await db
          .collection(`projects/${pid}/comments`)
          .where("branch", "==", "bob-sub")
          .get()
      ).size,
      1,
      "a new branch starts with its parent's comments",
    );
    await commitOn(s, objects, bob, pid, "bob-sub", page("Bob's sub."));
    const into = async (target) => {
      const preview = await s.previewMerge(bob, {
        projectId: pid,
        sourceBranch: "bob-sub",
        targetBranch: target,
      });
      return s.mergeBranches(bob, {
        projectId: pid,
        sourceBranch: "bob-sub",
        targetBranch: target,
        expectedSourceHead: preview.sourceHead,
        expectedTargetHead: preview.targetHead,
        requestId: unique(),
      });
    };
    await into("bob-pages");
    await assert.rejects(into("main"), { code: "permission-denied" });
    await s.openMergeRequest(bob, {
      projectId: pid,
      sourceBranch: "bob-pages",
      targetBranch: "main",
      title: "Act two pass",
      requestId: unique(),
    });

    // Another editor can't write on Bob's dedicated branch.
    await join(s, alice, pid, carol, { role: "editor" });
    const head = (
      await db.doc(`projects/${pid}/branches/bob-pages`).get()
    ).data().head;
    await assert.rejects(
      tryEdit(s, objects, carol, pid, "bob-pages", head, page("Carol.")),
      { code: "permission-denied" },
    );
    // The owner still can.
    await commitOn(s, objects, alice, pid, "bob-pages", page("Alice fixes."));
  },
);

test(
  "commenters read every branch but can't save, branch or commit",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const { projectId: pid, head } = await s.createProject(alice, {
      title: "Options",
      requestId: unique(),
    });
    const { invite, accepted } = await join(s, alice, pid, dave, {
      role: "commenter",
      note: "Notes welcome.",
    });
    assert.equal(accepted.role, "commenter");
    assert.equal(accepted.branch, null);
    assert.equal((await s.sharedInvitation(invite)).access, undefined);
    assert.equal(
      (await db.doc(`projects/${pid}/members/dave`).get()).data().access,
      undefined,
    );
    assert.equal(
      (await s.loadDraft(dave, { projectId: pid, branchId: "main" })).head,
      head,
    );
    await assert.rejects(
      tryEdit(s, objects, dave, pid, "main", head, page("No.")),
      { code: "permission-denied" },
    );
    await assert.rejects(
      s.createBranch(dave, {
        projectId: pid,
        name: "dave",
        sourceBranch: "main",
        expectedHead: head,
        requestId: unique(),
      }),
      { code: "permission-denied" },
    );
    // The owner can move people between Reader, Commenter and Editor.
    await s.updateMemberRole(alice, {
      projectId: pid,
      uid: "dave",
      role: "editor",
    });
    assert.deepEqual(
      (await db.doc(`projects/${pid}/members/dave`).get()).data().access,
      { editMain: false, commentMain: true, branch: null },
    );
    await s.updateMemberRole(alice, {
      projectId: pid,
      uid: "dave",
      role: "commenter",
    });
    assert.equal(
      (await db.doc(`projects/${pid}/members/dave`).get()).data().role,
      "commenter",
    );
  },
);

test(
  "an invitation that requires sign-in shows its details but not the screenplay until the invited person accepts",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const { projectId: pid } = await s.createProject(alice, {
      title: "Private",
      requestId: unique(),
    });
    await commitOn(s, objects, alice, pid, "main", page("Secret pages."));
    const invite = await inviteWithToken(s, alice, {
      projectId: pid,
      email: bob.email,
      role: "reviewer",
      requireSignIn: true,
      requestId: unique(),
    });
    const stored = (
      await db.doc(`projects/${pid}/invitations/${invite.invitationId}`).get()
    ).data();
    assert.equal(stored.requireSignIn, true);
    const mail = (
      await db
        .collection("invitationMail")
        .where("invitationId", "==", invite.invitationId)
        .get()
    ).docs[0].data();
    assert.equal(mail.requireSignIn, true);
    // The link still shows who invited you to what...
    const info = await s.sharedInvitation(invite);
    assert.equal(info.title, "Private");
    assert.equal(info.requireSignIn, true);
    // ...but reading the draft, the graph or the history needs an account.
    for (const extra of [{}, { graph: true }, { history: true }])
      await assert.rejects(s.sharedInvitation({ ...invite, ...extra }, true), {
        code: "permission-denied",
      });
    // Someone else signed in can't accept it.
    await assert.rejects(s.acceptInvitation(carol, invite), {
      code: "permission-denied",
    });
    // The invited person accepts and reads as a member.
    const accepted = await s.acceptInvitation(bob, invite);
    assert.equal(accepted.role, "reviewer");
    const loaded = await s.loadDraft(bob, { projectId: pid, branchId: "main" });
    assert.equal(loaded.draft.blocks.at(-1).text, "Secret pages.");
    // Accepting doesn't open the link for anyone else.
    await assert.rejects(s.sharedInvitation(invite, true), {
      code: "permission-denied",
    });
    // Without the option, links keep working as before.
    const open = await inviteWithToken(s, alice, {
      projectId: pid,
      email: carol.email,
      role: "reviewer",
      requestId: unique(),
    });
    assert.equal((await s.sharedInvitation(open)).requireSignIn, false);
    assert.equal(
      (await s.sharedInvitation(open, true)).draft.blocks.at(-1).text,
      "Secret pages.",
    );
  },
);

test(
  "a new project gets a title page: project title, written by, the owner's name, contact placeholders",
  { skip: !enabled },
  async () => {
    const { s, objects } = fixture();
    const owner = { ...actor("jesse"), name: "Jesse Nicholas" };
    const { projectId: pid } = await s.createProject(owner, {
      title: "This house is the worst",
      requestId: unique(),
    });
    const expected = {
      title: "THIS HOUSE IS THE WORST",
      credit: "written by",
      authors: "Jesse Nicholas",
      contact: "Company\nAddress\nPhone\nEmail",
    };
    const first = await s.loadDraft(owner, { projectId: pid, branchId: "main" });
    assert.deepEqual(first.draft.titlePage, expected);
    // Renaming the project leaves the title page alone.
    await s.renameProject(owner, { projectId: pid, title: "Renamed" });
    assert.deepEqual(
      (await s.loadDraft(owner, { projectId: pid, branchId: "main" })).draft
        .titlePage,
      expected,
    );
    // Edits to the title page are committed like any other change.
    const edited = { ...expected, contact: "J Nicks Productions" };
    await commitOn(s, objects, owner, pid, "main", {
      ...page("Pages."),
      titlePage: edited,
    });
    assert.deepEqual(
      (await s.loadDraft(owner, { projectId: pid, branchId: "main" })).draft
        .titlePage,
      edited,
    );
    // Without a profile name the author line is left for the writer to fill.
    const { projectId: untitled } = await s.createProject(
      { ...actor("anon"), name: "Writer" },
      { title: "Untitled screenplay", requestId: unique() },
    );
    const blank = await s.loadDraft(actor("anon"), {
      projectId: untitled,
      branchId: "main",
    });
    assert.equal(blank.draft.titlePage.title, "UNTITLED");
    assert.equal(blank.draft.titlePage.authors, "");
    // An imported draft keeps its own title page.
    const own = { title: "MINE", credit: "by", authors: "Me", contact: "" };
    const { projectId: imported } = await s.createProject(owner, {
      title: "Imported",
      draft: { ...page("Imported."), titlePage: own },
      requestId: unique(),
    });
    assert.deepEqual(
      (await s.loadDraft(owner, { projectId: imported, branchId: "main" }))
        .draft.titlePage,
      own,
    );
  },
);
