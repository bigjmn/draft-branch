import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { GitService, blobId } from "./git";
import { type Resolution, MAX_RESOLUTION_TEXT, mergeDrafts } from "./merge";
import type { ObjectStore } from "./objects";
import {
  type Actor,
  type Branch,
  type CommitJob,
  type Role,
  MAX_DRAFT_BYTES,
  assertMergeInto,
  assertPublish,
  assertRequest,
  assertRole,
  authorName,
  blankSnapshot,
  branchId,
  fail,
  hash,
  id,
  oid,
  parseSnapshot,
  record,
  requestKey,
  serializeSnapshot,
  text,
  version,
} from "./model";

const now = () => FieldValue.serverTimestamp();
const MEMBERS: Role[] = ["owner", "editor", "reviewer"];
/** Commits shown in the version-control graph (newest first). */
export const GRAPH_LIMIT = 300;
const WRITERS: Role[] = ["owner", "editor"];

export class ProjectService {
  readonly git: GitService;
  constructor(
    readonly db: Firestore,
    readonly objects: ObjectStore,
    readonly publicOrigin = process.env.PUBLIC_APP_URL ||
      (process.env.FIRESTORE_EMULATOR_HOST ? "http://localhost:3010" : ""),
  ) {
    this.git = new GitService(objects);
  }
  private project(pid: string) {
    return this.db.doc(`projects/${pid}`);
  }
  private member(pid: string, uid: string) {
    return this.project(pid).collection("members").doc(uid);
  }
  private branch(pid: string, name: string) {
    return this.project(pid).collection("branches").doc(name);
  }
  private draft(pid: string, uid: string, branch: string) {
    return this.project(pid)
      .collection("workingDrafts")
      .doc(uid)
      .collection("branches")
      .doc(branch);
  }
  private async access(
    tx: Transaction,
    pid: string,
    actor: Actor,
    roles: Role[] = MEMBERS,
  ) {
    const [project, member] = await tx.getAll(
      this.project(pid),
      this.member(pid, actor.uid),
    );
    if (!project.exists || project.data()?.deleting)
      fail("not-found", "Project not found.");
    assertRole(member.data()?.role, roles);
    return { project: project.data()!, role: member.data()!.role as Role };
  }
  private async checkAccess(
    pid: string,
    actor: Actor,
    roles: Role[] = MEMBERS,
  ) {
    return this.db.runTransaction((tx) => this.access(tx, pid, actor, roles));
  }

  /** A durable deletion job revokes access immediately and survives worker retries. */
  async deleteProject(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const job = this.db.doc(`projectDeletions/${pid}`);
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(job);
      if (existing.exists) {
        if (existing.data()!.ownerUid !== actor.uid)
          fail("permission-denied", "Only the owner can delete a project.");
        return { status: existing.data()!.status };
      }
      const { project } = await this.access(tx, pid, actor, ["owner"]);
      if (data.confirmTitle !== project.title)
        fail(
          "invalid-argument",
          "Type the current project title to confirm deletion.",
        );
      const members = await tx.get(this.project(pid).collection("members"));
      tx.update(this.project(pid), { deleting: true, updatedAt: now() });
      for (const member of members.docs)
        tx.delete(this.db.doc(`users/${member.id}/projects/${pid}`));
      tx.create(job, {
        ownerUid: actor.uid,
        status: "queued",
        createdAt: now(),
      });
      return { status: "queued" };
    });
  }
  async processDeletion(pid: string) {
    const job = this.db.doc(`projectDeletions/${id(pid)}`);
    const state = await job.get();
    if (!state.exists || state.data()!.status === "complete") return;
    if (!this.objects.deletePrefix)
      throw new Error("Object cleanup is unavailable.");
    // Remove all branches, comments, invitations, drafts, commits and staging tickets.
    await this.db.recursiveDelete(this.project(pid));
    const mail = await this.db
      .collection("invitationMail")
      .where("projectId", "==", pid)
      .get();
    await Promise.all(
      mail.docs.map(async (item) => {
        await item.ref.delete();
        await this.db.doc(`emulatorMail/${item.id}`).delete();
      }),
    );
    await this.objects.deletePrefix(`projects/${pid}/`);
    await job.update({ status: "complete", completedAt: now() });
  }

  async renameProject(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      title = text(data.title, "project title");
    await this.db.runTransaction(async (tx) => {
      await this.access(tx, pid, actor, ["owner"]);
      const members = await tx.get(this.project(pid).collection("members"));
      tx.update(this.project(pid), { title, updatedAt: now() });
      for (const member of members.docs)
        tx.set(
          this.db.doc(`users/${member.id}/projects/${pid}`),
          { title },
          { merge: true },
        );
    });
    return { title };
  }

  async createProject(actor: Actor, input: unknown) {
    const data = record(input),
      title = text(data.title, "project title");
    const pid = requestKey(actor, data.requestId),
      snapshot =
        data.draft === undefined
          ? blankSnapshot(title)
          : parseSnapshot({ ...record(data.draft), title }),
      fingerprint = hash(
        JSON.stringify(
          data.draft === undefined ? { title } : { title, snapshot },
        ),
      );
    if ((await this.db.doc(`projectDeletions/${pid}`).get()).exists)
      fail(
        "failed-precondition",
        "This project was deleted. Start a new project instead.",
      );
    const existing = await this.project(pid).get();
    if (existing.exists) {
      if (existing.data()?.deleting)
        fail("not-found", "Project is being deleted.");
      assertRequest(existing.data(), fingerprint);
      return {
        projectId: pid,
        branchId: "main",
        head: existing.data()!.initialCommit,
      };
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const initial = await this.git.commit(
      pid,
      snapshot,
      [],
      "Create project",
      actor,
      timestamp,
    );
    return this.db.runTransaction(async (tx) => {
      const [project, deletion] = await tx.getAll(
        this.project(pid),
        this.db.doc(`projectDeletions/${pid}`),
      );
      if (deletion.exists || project.data()?.deleting)
        fail("failed-precondition", "Project was deleted.");
      if (project.exists) {
        assertRequest(project.data(), fingerprint);
        return {
          projectId: pid,
          branchId: "main",
          head: project.data()!.initialCommit,
        };
      }
      tx.create(this.project(pid), {
        title,
        ownerUid: actor.uid,
        visibility: "private",
        defaultBranch: "main",
        schemaVersion: 1,
        initialCommit: initial.oid,
        fingerprint,
        createdAt: now(),
        updatedAt: now(),
      });
      tx.create(this.member(pid, actor.uid), {
        uid: actor.uid,
        role: "owner",
        displayName: authorName(actor),
        ...(actor.email ? { email: actor.email } : {}),
        joinedAt: now(),
      });
      tx.set(this.db.doc(`users/${actor.uid}/projects/${pid}`), {
        projectId: pid,
        title,
        role: "owner",
        joinedAt: now(),
      });
      tx.create(this.branch(pid, "main"), {
        name: "main",
        head: initial.oid,
        protected: true,
        createdBy: actor.uid,
        createdAt: now(),
        updatedAt: now(),
      });
      tx.create(this.project(pid).collection("commits").doc(initial.oid), {
        ...initial,
        actorUid: actor.uid,
        authorName: authorName(actor),
        message: "Create project",
        timestamp,
        createdAt: now(),
      });
      return { projectId: pid, branchId: "main", head: initial.oid };
    });
  }

  async beginDraftUpload(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      branch = branchId(data.branchId);
    const baseCommit = oid(data.baseCommit),
      expectedVersion = version(data.expectedVersion);
    const uploadHash = text(data.contentHash, "content hash", 64);
    if (!/^[a-f0-9]{64}$/.test(uploadHash))
      fail("invalid-argument", "Invalid content hash.");
    const uploadId = requestKey(actor, data.requestId);
    const path = `projects/${pid}/uploads/${actor.uid}/${uploadId}`;
    const fingerprint = hash(
      JSON.stringify({ branch, baseCommit, expectedVersion, uploadHash }),
    );
    const ticket = this.project(pid).collection("uploads").doc(uploadId);
    return this.db.runTransaction(async (tx) => {
      await this.access(tx, pid, actor, WRITERS);
      const [existing, branchDoc, commit, draft] = await tx.getAll(
        ticket,
        this.branch(pid, branch),
        this.project(pid).collection("commits").doc(baseCommit),
        this.draft(pid, actor.uid, branch),
      );
      if (existing.exists) {
        assertRequest(existing.data(), fingerprint);
        return { uploadId, path, status: existing.data()!.status };
      }
      if (!branchDoc.exists || !commit.exists)
        fail("not-found", "Branch or base revision not found.");
      if ((draft.data()?.version ?? 0) !== expectedVersion)
        fail("aborted", "The cloud draft changed. Reload before saving.");
      tx.create(ticket, {
        actorUid: actor.uid,
        branchId: branch,
        baseCommit,
        expectedVersion,
        fingerprint,
        uploadHash,
        path,
        status: "awaiting_upload",
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
        createdAt: now(),
      });
      return { uploadId, path, status: "awaiting_upload" };
    });
  }

  /** Storage finalize events are duplicate/out-of-order safe. Only one accepted
   * ticket can advance a particular working draft from version N to N+1. */
  async finalizeUpload(
    path: string,
    generation: string,
    size: number,
    contentType: string | undefined,
  ) {
    const match =
      /^projects\/([A-Za-z0-9_-]+)\/uploads\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(
        path,
      );
    if (!match) return;
    const [, pid, uid, uploadId] = match;
    const ticketRef = this.project(pid).collection("uploads").doc(uploadId);
    const ticket = await ticketRef.get();
    if (!ticket.exists || ticket.data()!.status !== "awaiting_upload") return;
    const input = ticket.data()!;
    if (input.path !== path || input.actorUid !== uid) return;
    try {
      if (size > MAX_DRAFT_BYTES || contentType !== "application/json")
        fail("invalid-argument", "Upload must be JSON no larger than 2 MiB.");
      if (input.expiresAt.toMillis() <= Date.now())
        fail("deadline-exceeded", "Upload ticket expired.");
      const bytes = await this.objects.get(path, generation);
      if (bytes.length > MAX_DRAFT_BYTES)
        fail("invalid-argument", "Upload exceeds 2 MiB.");
      if (hash(bytes) !== input.uploadHash)
        fail(
          "invalid-argument",
          "Upload does not match the requested content hash.",
        );
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("invalid-argument", "Malformed screenplay JSON.");
      }
      const snapshot = Buffer.from(serializeSnapshot(json));
      const snapshotPath = `projects/${pid}/drafts/${uid}/${uploadId}.json`;
      await this.objects.put(snapshotPath, snapshot, "application/json");
      await this.db.runTransaction(async (tx) => {
        const [latest, member, draft] = await tx.getAll(
          ticketRef,
          this.member(pid, uid),
          this.draft(pid, uid, input.branchId),
        );
        if (latest.data()?.status !== "awaiting_upload") return;
        if (!WRITERS.includes(member.data()?.role)) {
          tx.update(ticketRef, {
            status: "rejected",
            error: "Project access was removed.",
            completedAt: now(),
          });
          return;
        }
        if (latest.data()!.expiresAt.toMillis() <= Date.now()) {
          tx.update(ticketRef, {
            status: "rejected",
            error: "Upload ticket expired.",
            completedAt: now(),
          });
          return;
        }
        if ((draft.data()?.version ?? 0) !== input.expectedVersion) {
          tx.update(ticketRef, {
            status: "conflict",
            error: "The cloud draft changed.",
            completedAt: now(),
          });
          return;
        }
        tx.set(this.draft(pid, uid, input.branchId), {
          actorUid: uid,
          branchId: input.branchId,
          baseCommit: input.baseCommit,
          version: input.expectedVersion + 1,
          uploadId,
          snapshotPath,
          contentHash: hash(snapshot),
          updatedAt: now(),
        });
        tx.update(ticketRef, {
          status: "accepted",
          generation,
          version: input.expectedVersion + 1,
          completedAt: now(),
        });
      });
    } catch (error) {
      if (!(error instanceof HttpsError)) throw error; // Transient infrastructure failures must retry.
      await this.db.runTransaction(async (tx) => {
        const latest = await tx.get(ticketRef);
        if (latest.data()?.status === "awaiting_upload")
          tx.update(ticketRef, {
            status: "rejected",
            error: error.message,
            completedAt: now(),
          });
      });
    }
  }

  async commitDraft(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      branch = branchId(data.branchId);
    const expectedHead = oid(data.expectedHead),
      draftVersion = version(data.draftVersion);
    const message = text(data.message, "commit message", 2000),
      operationId = requestKey(actor, data.requestId);
    const fingerprint = hash(
      JSON.stringify({ branch, expectedHead, draftVersion, message }),
    );
    const jobRef = this.project(pid).collection("operations").doc(operationId);
    return this.db.runTransaction(async (tx) => {
      const { role } = await this.access(tx, pid, actor, WRITERS);
      const [job, branchDoc, draft] = await tx.getAll(
        jobRef,
        this.branch(pid, branch),
        this.draft(pid, actor.uid, branch),
      );
      if (job.exists) {
        assertRequest(job.data(), fingerprint);
        return { operationId, status: job.data()!.status };
      }
      if (!branchDoc.exists) fail("not-found", "Branch not found.");
      assertPublish(role, branchDoc.data() as Branch);
      if (branchDoc.data()!.head !== expectedHead)
        fail("aborted", "Branch advanced. Bring in updates before committing.");
      if (
        !draft.exists ||
        draft.data()!.version !== draftVersion ||
        draft.data()!.baseCommit !== expectedHead
      )
        fail(
          "failed-precondition",
          "Save a current cloud draft based on this branch head first.",
        );
      tx.create(jobRef, {
        actor,
        branchId: branch,
        expectedHead,
        snapshotPath: draft.data()!.snapshotPath,
        contentHash: draft.data()!.contentHash,
        draftVersion,
        message,
        fingerprint,
        timestamp: Math.floor(Date.now() / 1000),
        status: "queued",
        createdAt: now(),
      });
      return { operationId, status: "queued" };
    });
  }

  /** Firestore onCreate handler. Objects are immutable, authors/timestamps are
   * frozen in the job, and only the final transaction is allowed to move a ref. */
  async processCommit(pid: string, operationId: string) {
    const jobRef = this.project(pid).collection("operations").doc(operationId);
    const snapshot = await jobRef.get();
    if (!snapshot.exists || snapshot.data()!.status !== "queued") return;
    const job = snapshot.data() as CommitJob & {
      contentHash: string;
      draftVersion: number;
    };
    try {
      const { role } = await this.checkAccess(pid, job.actor, WRITERS);
      const branchDoc = await this.branch(pid, job.branchId).get();
      if (!branchDoc.exists) fail("not-found", "Branch no longer exists.");
      assertPublish(role, branchDoc.data() as Branch);
      if (branchDoc.data()!.head !== job.expectedHead)
        fail("aborted", "Branch advanced. No revision was published.");
      const bytes = await this.objects.get(job.snapshotPath);
      if (hash(bytes) !== job.contentHash)
        fail("data-loss", "Draft snapshot integrity mismatch.");
      const draft = parseSnapshot(JSON.parse(bytes.toString()));
      const revision = await this.git.commit(
        pid,
        draft,
        [job.expectedHead],
        job.message,
        job.actor,
        job.timestamp,
      );
      await this.db.runTransaction(async (tx) => {
        const [latestJob, member, branch, working] = await tx.getAll(
          jobRef,
          this.member(pid, job.actor.uid),
          this.branch(pid, job.branchId),
          this.draft(pid, job.actor.uid, job.branchId),
        );
        if (latestJob.data()?.status !== "queued") return;
        if (!branch.exists) fail("not-found", "Branch no longer exists.");
        assertPublish(member.data()?.role, branch.data() as Branch);
        if (branch.data()!.head !== job.expectedHead)
          fail("aborted", "Branch advanced. No revision was published.");
        tx.set(this.project(pid).collection("commits").doc(revision.oid), {
          ...revision,
          actorUid: job.actor.uid,
          authorName: authorName(job.actor),
          message: job.message,
          timestamp: job.timestamp,
          operationId,
          createdAt: now(),
        });
        tx.update(this.branch(pid, job.branchId), {
          head: revision.oid,
          updatedAt: now(),
        });
        tx.update(this.project(pid), { updatedAt: now() });
        tx.update(jobRef, {
          status: "succeeded",
          commitId: revision.oid,
          completedAt: now(),
        });
        // Do not rebase or overwrite edits saved while this commit was running.
        if (working.data()?.version === job.draftVersion)
          tx.update(working.ref, {
            baseCommit: revision.oid,
            version: job.draftVersion + 1,
            updatedAt: now(),
          });
      });
    } catch (error) {
      if (!(error instanceof HttpsError)) throw error;
      await this.db.runTransaction(async (tx) => {
        const latest = await tx.get(jobRef);
        if (latest.data()?.status === "queued")
          tx.update(jobRef, {
            status: error.code === "aborted" ? "conflict" : "rejected",
            error: error.message,
            completedAt: now(),
          });
      });
    }
  }

  async createBranch(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      name = branchId(data.name),
      source = branchId(data.sourceBranch);
    const expectedHead = oid(data.expectedHead),
      key = requestKey(actor, data.requestId);
    const fingerprint = hash(JSON.stringify({ name, source, expectedHead }));
    const request = this.project(pid).collection("requests").doc(key);
    return this.db.runTransaction(async (tx) => {
      await this.access(tx, pid, actor, WRITERS);
      const [prior, sourceDoc, target] = await tx.getAll(
        request,
        this.branch(pid, source),
        this.branch(pid, name),
      );
      if (prior.exists) {
        assertRequest(prior.data(), fingerprint);
        return { branchId: name, head: prior.data()!.head };
      }
      if (target.exists) fail("already-exists", "Branch already exists.");
      if (!sourceDoc.exists) fail("not-found", "Source branch not found.");
      if (sourceDoc.data()!.head !== expectedHead)
        fail("aborted", "Source branch advanced.");
      tx.create(this.branch(pid, name), {
        name,
        head: expectedHead,
        protected: false,
        createdBy: actor.uid,
        sourceBranch: source,
        createdAt: now(),
        updatedAt: now(),
      });
      tx.create(request, {
        actorUid: actor.uid,
        fingerprint,
        head: expectedHead,
        createdAt: now(),
      });
      return { branchId: name, head: expectedHead };
    });
  }

  async inviteMember(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const email = text(data.email, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fail("invalid-argument", "Invalid email.");
    const role = data.role;
    if (role !== "editor" && role !== "reviewer")
      fail("invalid-argument", "Invite role must be editor or reviewer.");
    let origin: URL;
    try {
      origin = new URL(this.publicOrigin);
    } catch {
      return fail(
        "failed-precondition",
        "Email sharing is not configured yet.",
      );
    }
    if (
      origin.protocol !== "https:" &&
      !(process.env.FIRESTORE_EMULATOR_HOST && origin.hostname === "localhost")
    )
      fail("failed-precondition", "Sharing requires an HTTPS application URL.");
    const invitationId = requestKey(actor, data.requestId);
    const ref = this.project(pid).collection("invitations").doc(invitationId);
    const fingerprint = hash(JSON.stringify({ email, role }));
    const token = randomBytes(32).toString("hex");
    const quotaRef = this.db.doc(`invitationLimits/${actor.uid}`);
    return this.db.runTransaction(async (tx) => {
      const { project } = await this.access(tx, pid, actor, ["owner"]);
      const [existing, quota] = await tx.getAll(ref, quotaRef);
      if (existing.exists) {
        assertRequest(existing.data(), fingerprint);
        return {
          invitationId,
          projectId: pid,
          status: existing.data()!.status,
        };
      }
      const freshWindow =
        !quota.exists || quota.data()!.windowStart < Date.now() - 3600000;
      const count = freshWindow ? 0 : quota.data()!.count;
      if (count >= 50)
        fail(
          "resource-exhausted",
          "Invitation limit reached. Try again later.",
        );
      tx.set(quotaRef, {
        count: count + 1,
        windowStart: freshWindow ? Date.now() : quota.data()!.windowStart,
      });
      const ownerName =
        actor.name === "Writer"
          ? actor.email?.split("@")[0] || "The project owner"
          : actor.name;
      tx.create(ref, {
        email,
        role,
        invitedBy: actor.uid,
        ownerName,
        status: "pending",
        fingerprint,
        tokenHash: hash(token),
        deliveryStatus: "queued",
        expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86400000),
        createdAt: now(),
      });
      const link = `${origin.origin}/invite?project=${pid}&invitation=${invitationId}#token=${token}`;
      tx.create(
        this.db.doc(`invitationMail/${hash(`${pid}:${invitationId}`)}`),
        {
          projectId: pid,
          invitationId,
          to: email,
          ownerName,
          title: project.title,
          role,
          link,
          status: "queued",
          attempts: 0,
          createdAt: now(),
        },
      );
      return { invitationId, projectId: pid, status: "pending" };
    });
  }

  private assertToken(invitation: { tokenHash?: string }, value: unknown) {
    if (
      typeof value !== "string" ||
      !/^[a-f0-9]{64}$/.test(value) ||
      !invitation.tokenHash
    )
      fail("permission-denied", "Invitation link is invalid or unavailable.");
    const actual = Buffer.from(hash(value), "hex"),
      expected = Buffer.from(invitation.tokenHash, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
      fail("permission-denied", "Invitation link is invalid or unavailable.");
  }

  /** Invitation capability: committed project tree only, never private working drafts. */
  async sharedInvitation(input: unknown, includeDraft = false) {
    const data = record(input),
      pid = id(data.projectId),
      invitationId = id(data.invitationId);
    const check = () =>
      this.db.runTransaction(async (tx) => {
        const [invite, project] = await tx.getAll(
          this.project(pid).collection("invitations").doc(invitationId),
          this.project(pid),
        );
        if (!invite.exists || !project.exists || project.data()?.deleting)
          fail(
            "permission-denied",
            "Invitation link is invalid or unavailable.",
          );
        const invitation = invite.data()!;
        this.assertToken(invitation, data.token);
        if (
          !["pending", "accepted"].includes(invitation.status) ||
          invitation.expiresAt.toMillis() <= Date.now()
        )
          fail(
            "permission-denied",
            "This invitation has expired or been revoked.",
          );
        const owner = await tx.get(this.member(pid, invitation.invitedBy));
        assertRole(owner.data()?.role, ["owner"]);
        if (invitation.status === "accepted") {
          const member = await tx.get(this.member(pid, invitation.acceptedBy));
          if (!member.exists)
            fail(
              "permission-denied",
              "This invitation is no longer available.",
            );
        }
        return {
          title: project.data()!.title as string,
          ownerName: String(invitation.ownerName || "The project owner"),
          role: invitation.role as Role,
          expiresAt: invitation.expiresAt.toMillis() as number,
        };
      });
    const metadata = await check();
    if (!includeDraft) return metadata;
    if (data.graph === true) {
      // Commit metadata only: messages, authors, parents. No screenplay text.
      const rows = await this.project(pid)
        .collection("commits")
        .orderBy("timestamp", "desc")
        .limit(GRAPH_LIMIT)
        .get();
      const commits = rows.docs.map((item) => ({
        oid: item.id,
        message: item.get("message"),
        actorUid: item.get("actorUid"),
        authorName: item.get("authorName") ?? null,
        timestamp: item.get("timestamp"),
        parent: item.get("parent"),
      }));
      await check();
      return { ...metadata, commits };
    }
    const branchName = branchId(data.branchId ?? "main");
    const branch = await this.branch(pid, branchName).get();
    if (!branch.exists) fail("not-found", "Branch not found.");
    const commitId =
      data.commitId === undefined ? branch.data()!.head : oid(data.commitId);
    // Only committed objects in this project are readable. Never accept storage paths.
    const revision = await this.project(pid)
      .collection("commits")
      .doc(commitId)
      .get();
    if (!revision.exists) fail("not-found", "Revision not found.");
    if (data.history === true) {
      const history = [];
      const seen = new Set<string>();
      let cursor: string | undefined = commitId;
      while (cursor && history.length < 50 && !seen.has(cursor)) {
        seen.add(cursor);
        const item = await this.project(pid)
          .collection("commits")
          .doc(cursor)
          .get();
        if (!item.exists) fail("not-found", "Revision not found.");
        const row = item.data()!;
        history.push({
          oid: cursor,
          message: row.message,
          actorUid: row.actorUid,
          authorName: row.authorName ?? null,
          timestamp: row.timestamp,
          parent: row.parent,
        });
        cursor = row.parent[0];
      }
      await check();
      return { ...metadata, history };
    }
    const draft = await this.git.readSnapshot(pid, revision.data()!.blob);
    const branches = (
      await this.project(pid).collection("branches").get()
    ).docs.map((item) => {
      const row = item.data();
      return { name: row.name, head: row.head, protected: row.protected };
    });
    await check();
    return {
      ...metadata,
      draft,
      commitId,
      branchId: branchName,
      branches,
      parent: revision.data()!.parent as string[],
    };
  }

  async acceptInvitation(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      invitationId = id(data.invitationId);
    if (!actor.emailVerified || !actor.email)
      fail(
        "failed-precondition",
        "Verify your email before accepting an invitation.",
      );
    const ref = this.project(pid).collection("invitations").doc(invitationId);
    return this.db.runTransaction(async (tx) => {
      const [invite, project, member] = await tx.getAll(
        ref,
        this.project(pid),
        this.member(pid, actor.uid),
      );
      if (!invite.exists || !project.exists || project.data()?.deleting)
        fail("not-found", "Invitation not found.");
      const invitation = invite.data()!;
      if (invitation.tokenHash) this.assertToken(invitation, data.token);
      if (invitation.email !== actor.email!.toLowerCase())
        fail("permission-denied", "Invitation belongs to a different email.");
      if (
        invitation.status === "accepted" &&
        invitation.acceptedBy === actor.uid &&
        member.exists
      )
        return { projectId: pid, role: member.data()!.role };
      if (
        invitation.status !== "pending" ||
        invitation.expiresAt.toMillis() <= Date.now()
      )
        fail(
          "failed-precondition",
          "Invitation expired or is no longer pending.",
        );
      const owner = await tx.get(this.member(pid, invitation.invitedBy));
      assertRole(owner.data()?.role, ["owner"]);
      // An invitation cannot demote or promote an existing membership implicitly.
      const role = member.data()?.role ?? invitation.role;
      tx.set(this.member(pid, actor.uid), {
        uid: actor.uid,
        role,
        email: actor.email,
        displayName: actor.name,
        joinedAt: member.data()?.joinedAt ?? now(),
      });
      tx.set(this.db.doc(`users/${actor.uid}/projects/${pid}`), {
        projectId: pid,
        title: project.data()!.title,
        role,
        joinedAt: now(),
      });
      tx.update(ref, {
        status: "accepted",
        acceptedBy: actor.uid,
        acceptedAt: now(),
      });
      return { projectId: pid, role };
    });
  }

  async removeMember(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      uid = id(data.uid, "user id");
    await this.db.runTransaction(async (tx) => {
      const { project } = await this.access(tx, pid, actor, ["owner"]);
      if (uid === project.ownerUid)
        fail("failed-precondition", "The project owner cannot be removed.");
      const invitations = await tx.get(
        this.project(pid)
          .collection("invitations")
          .where("acceptedBy", "==", uid),
      );
      for (const invite of invitations.docs)
        tx.update(invite.ref, { status: "revoked", updatedAt: now() });
      tx.delete(this.member(pid, uid));
      tx.delete(this.db.doc(`users/${uid}/projects/${pid}`));
    });
    return { removed: true };
  }

  async updateMemberRole(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      uid = id(data.uid);
    if (data.role !== "editor" && data.role !== "reviewer")
      fail("invalid-argument", "Choose Reader or Editor.");
    await this.db.runTransaction(async (tx) => {
      const { project } = await this.access(tx, pid, actor, ["owner"]);
      const member = await tx.get(this.member(pid, uid));
      if (!member.exists || uid === project.ownerUid)
        fail("failed-precondition", "Cannot change this member.");
      tx.update(this.member(pid, uid), { role: data.role });
      tx.update(this.db.doc(`users/${uid}/projects/${pid}`), {
        role: data.role,
      });
    });
    return { updated: true };
  }

  async revokeInvitation(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      invitationId = id(data.invitationId);
    const ref = this.project(pid).collection("invitations").doc(invitationId);
    await this.db.runTransaction(async (tx) => {
      await this.access(tx, pid, actor, ["owner"]);
      const invite = await tx.get(ref);
      if (!invite.exists) fail("not-found", "Invitation not found.");
      if (["pending", "accepted"].includes(invite.data()!.status))
        tx.update(ref, { status: "revoked", updatedAt: now() });
    });
    return { revoked: true };
  }

  async loadDraft(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      branch = branchId(data.branchId);
    const { role } = await this.checkAccess(pid, actor);
    const branchDoc = await this.branch(pid, branch).get();
    if (!branchDoc.exists) fail("not-found", "Branch not found.");
    const working = await this.draft(pid, actor.uid, branch).get();
    const head = branchDoc.data()!.head as string;
    if (working.exists && role !== "reviewer") {
      const saved = working.data()!;
      const bytes = await this.objects.get(saved.snapshotPath);
      if (hash(bytes) !== saved.contentHash)
        fail("data-loss", "Draft snapshot integrity mismatch.");
      // A draft identical to its base commit holds no uncommitted writing, so
      // it can follow the branch after someone else commits or merges. Drafts
      // with real changes keep their base and go through "Bring in updates".
      if (saved.baseCommit !== head) {
        const base = await this.project(pid)
          .collection("commits")
          .doc(saved.baseCommit)
          .get();
        if (base.exists && base.data()!.blob === blobId(bytes)) {
          const latest = await this.snapshotAt(pid, head);
          await this.checkAccess(pid, actor);
          return {
            draft: latest,
            version: saved.version as number,
            baseCommit: head,
            head,
          };
        }
      }
      await this.checkAccess(pid, actor);
      return {
        draft: parseSnapshot(JSON.parse(bytes.toString())),
        version: saved.version as number,
        baseCommit: saved.baseCommit as string,
        head,
      };
    }
    const revision = await this.project(pid)
      .collection("commits")
      .doc(head)
      .get();
    if (!revision.exists) fail("data-loss", "Branch revision is missing.");
    const draft = await this.git.readSnapshot(pid, revision.data()!.blob);
    await this.checkAccess(pid, actor);
    return { draft, version: 0, baseCommit: head, head };
  }

  async readRevision(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId),
      commitId = oid(data.commitId);
    await this.checkAccess(pid, actor);
    const revision = await this.project(pid)
      .collection("commits")
      .doc(commitId)
      .get();
    if (!revision.exists) fail("not-found", "Revision not found.");
    const draft = await this.git.readSnapshot(pid, revision.data()!.blob);
    await this.checkAccess(pid, actor);
    return { draft, commitId, parent: revision.data()!.parent as string[] };
  }

  private async snapshotAt(pid: string, commitId: string) {
    const revision = await this.project(pid)
      .collection("commits")
      .doc(commitId)
      .get();
    if (!revision.exists) fail("data-loss", "A revision is missing.");
    return this.git.readSnapshot(pid, revision.data()!.blob);
  }

  /** Best common ancestor: a common ancestor that no other common ancestor
   * descends from (latest wins in criss-cross histories). */
  async mergeBase(pid: string, a: string, b: string): Promise<string> {
    const rows = await this.project(pid)
      .collection("commits")
      .select("parent", "timestamp")
      .get();
    const graph = new Map(
      rows.docs.map((d) => [
        d.id,
        {
          parent: (d.get("parent") ?? []) as string[],
          timestamp: Number(d.get("timestamp") ?? 0),
        },
      ]),
    );
    const ancestors = (start: string[]) => {
      const seen = new Set<string>();
      const stack = [...start];
      while (stack.length) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        stack.push(...(graph.get(oid)?.parent ?? []));
      }
      return seen;
    };
    const fromB = ancestors([b]);
    const common = [...ancestors([a])].filter((oid) => fromB.has(oid));
    if (!common.length)
      fail("failed-precondition", "These branches share no history.");
    const dominated = ancestors(
      common.flatMap((oid) => graph.get(oid)?.parent ?? []),
    );
    const best = common.filter((oid) => !dominated.has(oid));
    best.sort(
      (x, y) =>
        (graph.get(y)?.timestamp ?? 0) - (graph.get(x)?.timestamp ?? 0) ||
        (x < y ? -1 : 1),
    );
    return best[0];
  }

  private async mergeInputs(pid: string, source: string, target: string) {
    if (source === target)
      fail("invalid-argument", "Choose two different branches to merge.");
    const [sourceDoc, targetDoc] = await Promise.all([
      this.branch(pid, source).get(),
      this.branch(pid, target).get(),
    ]);
    if (!sourceDoc.exists || !targetDoc.exists)
      fail("not-found", "Branch not found.");
    const sourceHead = sourceDoc.data()!.head as string,
      targetHead = targetDoc.data()!.head as string;
    const baseCommit = await this.mergeBase(pid, targetHead, sourceHead);
    return {
      sourceHead,
      targetHead,
      baseCommit,
      targetBranch: targetDoc.data() as Branch,
    };
  }

  /** Everything the browser needs to show conflicts with the shared algorithm. */
  async previewMerge(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const source = branchId(data.sourceBranch),
      target = branchId(data.targetBranch);
    await this.checkAccess(pid, actor);
    const { sourceHead, targetHead, baseCommit } = await this.mergeInputs(
      pid,
      source,
      target,
    );
    const [base, ours, theirs] = await Promise.all([
      this.snapshotAt(pid, baseCommit),
      this.snapshotAt(pid, targetHead),
      this.snapshotAt(pid, sourceHead),
    ]);
    await this.checkAccess(pid, actor);
    return {
      sourceHead,
      targetHead,
      baseCommit,
      upToDate: baseCommit === sourceHead,
      fastForward: baseCommit === targetHead,
      base,
      target: ours,
      source: theirs,
    };
  }

  /** Creates a two-parent merge commit on the target branch. Merging into a
   * protected branch (main) is the owner's approval. */
  async mergeBranches(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const source = branchId(data.sourceBranch),
      target = branchId(data.targetBranch);
    const expectedSourceHead = oid(data.expectedSourceHead),
      expectedTargetHead = oid(data.expectedTargetHead);
    const resolutions = parseResolutions(data.resolutions);
    const mergeRequestId =
      data.mergeRequestId === undefined
        ? null
        : id(data.mergeRequestId, "merge request id");
    const message =
      data.message === undefined
        ? `Merge ${source} into ${target}`
        : text(data.message, "merge message", 2000);
    const key = requestKey(actor, data.requestId);
    const fingerprint = hash(
      JSON.stringify({
        source,
        target,
        expectedSourceHead,
        expectedTargetHead,
        resolutions,
        mergeRequestId,
        message,
      }),
    );
    const requestRef = this.project(pid).collection("requests").doc(key);
    const prior = await requestRef.get();
    if (prior.exists) {
      assertRequest(prior.data(), fingerprint);
      return prior.data()!.result as { commitId: string; branchId: string };
    }
    const { role } = await this.checkAccess(pid, actor, WRITERS);
    const inputs = await this.mergeInputs(pid, source, target);
    assertMergeInto(role, inputs.targetBranch);
    if (
      inputs.sourceHead !== expectedSourceHead ||
      inputs.targetHead !== expectedTargetHead
    )
      fail("aborted", "A branch changed. Review the merge again.");
    if (inputs.baseCommit === inputs.sourceHead)
      fail(
        "failed-precondition",
        `${target} already contains every revision on ${source}.`,
      );
    const [base, ours, theirs] = await Promise.all([
      this.snapshotAt(pid, inputs.baseCommit),
      this.snapshotAt(pid, inputs.targetHead),
      this.snapshotAt(pid, inputs.sourceHead),
    ]);
    const merged = mergeDrafts(base, ours, theirs, resolutions);
    if (merged.unresolved.length)
      fail(
        "failed-precondition",
        `Resolve ${merged.unresolved.length} conflict${merged.unresolved.length === 1 ? "" : "s"} before merging.`,
      );
    const snapshot = parseSnapshot({ ...merged.draft, schemaVersion: 1 });
    const timestamp = Math.floor(Date.now() / 1000);
    const revision = await this.git.commit(
      pid,
      snapshot,
      [inputs.targetHead, inputs.sourceHead],
      message,
      actor,
      timestamp,
    );
    const result = { commitId: revision.oid, branchId: target };
    const requests = this.project(pid).collection("mergeRequests");
    return this.db.runTransaction(async (tx) => {
      const [again, member, sourceDoc, targetDoc] = await tx.getAll(
        requestRef,
        this.member(pid, actor.uid),
        this.branch(pid, source),
        this.branch(pid, target),
      );
      if (again.exists) {
        assertRequest(again.data(), fingerprint);
        return again.data()!.result as typeof result;
      }
      const open = await tx.get(
        requests
          .where("sourceBranch", "==", source)
          .where("targetBranch", "==", target)
          .where("status", "==", "open"),
      );
      const named = mergeRequestId
        ? await tx.get(requests.doc(mergeRequestId))
        : null;
      if (!sourceDoc.exists || !targetDoc.exists)
        fail("not-found", "Branch no longer exists.");
      assertRole(member.data()?.role, WRITERS);
      assertMergeInto(member.data()?.role, targetDoc.data() as Branch);
      if (
        sourceDoc.data()!.head !== expectedSourceHead ||
        targetDoc.data()!.head !== expectedTargetHead
      )
        fail("aborted", "A branch changed. Review the merge again.");
      if (
        named &&
        (!named.exists ||
          named.data()!.status !== "open" ||
          named.data()!.sourceBranch !== source ||
          named.data()!.targetBranch !== target)
      )
        fail("failed-precondition", "This merge request is no longer open.");
      tx.set(this.project(pid).collection("commits").doc(revision.oid), {
        ...revision,
        actorUid: actor.uid,
        authorName: authorName(actor),
        message,
        timestamp,
        merge: {
          sourceBranch: source,
          targetBranch: target,
          ...(mergeRequestId ? { mergeRequestId } : {}),
        },
        createdAt: now(),
      });
      tx.update(this.branch(pid, target), {
        head: revision.oid,
        updatedAt: now(),
      });
      tx.update(this.project(pid), { updatedAt: now() });
      for (const request of open.docs)
        tx.update(request.ref, {
          status: "merged",
          mergedCommit: revision.oid,
          mergedBy: actor.uid,
          mergedByName: authorName(actor),
          mergedAt: now(),
        });
      tx.create(requestRef, {
        actorUid: actor.uid,
        fingerprint,
        result,
        createdAt: now(),
      });
      return result;
    });
  }

  /** Editors propose merges into protected branches; the owner approves them by merging. */
  async openMergeRequest(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const source = branchId(data.sourceBranch),
      target = branchId(data.targetBranch);
    if (source === target)
      fail("invalid-argument", "Choose two different branches to merge.");
    const title = text(data.title, "merge request title", 200);
    const description =
      data.description === undefined || data.description === ""
        ? ""
        : text(data.description, "description", 4000);
    const requestId = requestKey(actor, data.requestId);
    const fingerprint = hash(
      JSON.stringify({ source, target, title, description }),
    );
    const ref = this.project(pid).collection("mergeRequests").doc(requestId);
    return this.db.runTransaction(async (tx) => {
      await this.access(tx, pid, actor, WRITERS);
      const [existing, sourceDoc, targetDoc] = await tx.getAll(
        ref,
        this.branch(pid, source),
        this.branch(pid, target),
      );
      if (existing.exists) {
        assertRequest(existing.data(), fingerprint);
        return { mergeRequestId: requestId, status: existing.data()!.status };
      }
      const duplicate = await tx.get(
        this.project(pid)
          .collection("mergeRequests")
          .where("sourceBranch", "==", source)
          .where("targetBranch", "==", target)
          .where("status", "==", "open"),
      );
      if (!duplicate.empty)
        fail(
          "already-exists",
          "An open merge request already exists for these branches.",
        );
      if (!sourceDoc.exists || !targetDoc.exists)
        fail("not-found", "Branch not found.");
      tx.create(ref, {
        title,
        description,
        sourceBranch: source,
        targetBranch: target,
        sourceHead: sourceDoc.data()!.head,
        targetHead: targetDoc.data()!.head,
        authorUid: actor.uid,
        authorName: authorName(actor),
        status: "open",
        fingerprint,
        createdAt: now(),
        updatedAt: now(),
      });
      return { mergeRequestId: requestId, status: "open" };
    });
  }

  async closeMergeRequest(actor: Actor, input: unknown) {
    const data = record(input),
      pid = id(data.projectId);
    const ref = this.project(pid)
      .collection("mergeRequests")
      .doc(id(data.mergeRequestId, "merge request id"));
    await this.db.runTransaction(async (tx) => {
      const { role } = await this.access(tx, pid, actor);
      const request = await tx.get(ref);
      if (!request.exists) fail("not-found", "Merge request not found.");
      if (role !== "owner" && request.data()!.authorUid !== actor.uid)
        fail(
          "permission-denied",
          "Only the author or the owner can close this request.",
        );
      if (request.data()!.status === "open")
        tx.update(ref, {
          status: "closed",
          closedBy: actor.uid,
          closedByName: authorName(actor),
          updatedAt: now(),
        });
    });
    return { closed: true };
  }
}

const RESOLUTION_KEY = /^(title|(block|order|move):[A-Za-z0-9_-]{1,128})$/;
function parseResolutions(value: unknown): Record<string, Resolution> {
  if (value === undefined) return {};
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.length > 2000) fail("invalid-argument", "Too many resolutions.");
  const result: Record<string, Resolution> = {};
  for (const [key, choice] of entries) {
    if (!RESOLUTION_KEY.test(key))
      fail("invalid-argument", "Invalid conflict id.");
    if (choice === "target" || choice === "source" || choice === "both")
      result[key] = choice;
    else {
      const custom = record(choice);
      if (
        typeof custom.text !== "string" ||
        custom.text.length > MAX_RESOLUTION_TEXT
      )
        fail("invalid-argument", "Invalid conflict resolution.");
      result[key] = { text: custom.text };
    }
  }
  return result;
}
