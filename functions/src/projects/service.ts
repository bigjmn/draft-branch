import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { GitService } from "./git";
import type { ObjectStore } from "./objects";
import {
  type Actor,
  type Branch,
  type CommitJob,
  type Role,
  MAX_DRAFT_BYTES,
  assertPublish,
  assertRequest,
  assertRole,
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
    if (!project.exists) fail("not-found", "Project not found.");
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

  async createProject(actor: Actor, input: unknown) {
    const data = record(input),
      title = text(data.title, "project title");
    const pid = requestKey(actor, data.requestId),
      fingerprint = hash(JSON.stringify({ title }));
    const existing = await this.project(pid).get();
    if (existing.exists) {
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
      blankSnapshot(title),
      [],
      "Create project",
      actor,
      timestamp,
    );
    return this.db.runTransaction(async (tx) => {
      const project = await tx.get(this.project(pid));
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

  /** Capability access only: never returns a working draft, history, or arbitrary branch. */
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
        if (!invite.exists || !project.exists)
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
    const main = await this.branch(pid, "main").get();
    const revision = await this.project(pid)
      .collection("commits")
      .doc(main.data()!.head)
      .get();
    if (!revision.exists)
      fail("not-found", "Published screenplay unavailable.");
    const draft = await this.git.readSnapshot(pid, revision.data()!.blob);
    await check();
    return { ...metadata, draft, commitId: main.data()!.head as string };
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
      if (!invite.exists || !project.exists)
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
}
