/** Full local event-delivery smoke test. Run only with all four emulators. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const requireFunctions = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signOut,
  reload,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  getDoc,
  doc,
} from "firebase/firestore";
import {
  getStorage,
  connectStorageEmulator,
  uploadBytes,
  ref,
} from "firebase/storage";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { createHash, randomUUID } from "node:crypto";
async function main() {
  const app = initializeApp({
    projectId: "demo-draftbranch",
    apiKey: "demo-key",
    storageBucket: "demo-draftbranch.firebasestorage.app",
  });
  try {
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    const db = getFirestore(app);
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    const storage = getStorage(app);
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    const functions = getFunctions(app, "us-central1");
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    const call = async (name: string, data: unknown) =>
      (await httpsCallable(functions, name)(data)).data as Record<string, any>;
    await createUserWithEmailAndPassword(
      auth,
      `smoke-${randomUUID()}@example.com`,
      `test-${randomUUID()}`,
    );
    const p = await call("createProject", {
      title: "Smoke screenplay",
      requestId: randomUUID(),
    });
    const draft = {
      title: "Smoke screenplay",
      blocks: [
        { id: "scene-1", type: "scene", text: "INT. STUDIO - DAY" },
        { id: "action-1", type: "action", text: "A writer commits a scene." },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(draft));
    const ticket = await call("beginDraftUpload", {
      projectId: p.projectId,
      branchId: "main",
      baseCommit: p.head,
      expectedVersion: 0,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      requestId: randomUUID(),
    });
    await uploadBytes(ref(storage, ticket.path), bytes, {
      contentType: "application/json",
    });
    async function wait(path: string, pending: string) {
      for (let i = 0; i < 100; i++) {
        const value = (await getDoc(doc(db, path))).data();
        if (value && value.status !== pending) return value;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`Timed out waiting for ${path}`);
    }
    const saved = await wait(
      `projects/${p.projectId}/uploads/${ticket.uploadId}`,
      "awaiting_upload",
    );
    assert.equal(saved.status, "accepted", JSON.stringify(saved));
    const job = await call("commitDraft", {
      projectId: p.projectId,
      branchId: "main",
      expectedHead: p.head,
      draftVersion: saved.version,
      message: "Smoke scene",
      requestId: randomUUID(),
    });
    const result = await wait(
      `projects/${p.projectId}/operations/${job.operationId}`,
      "queued",
    );
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const revision = await call("readProjectRevision", {
      projectId: p.projectId,
      commitId: result.commitId,
    });
    assert.deepEqual(revision.draft.blocks, draft.blocks);
    // Exercise the actual public callables and email event worker, not only service methods.
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    const admin = requireFunctions("firebase-admin");
    const adminApp = admin.initializeApp(
      { projectId: "demo-draftbranch" },
      "sharing-smoke",
    );
    try {
      const recipient = `invite-${randomUUID()}@example.com`;
      const invite = await call("inviteProjectMember", {
        projectId: p.projectId,
        email: recipient,
        role: "editor",
        requestId: randomUUID(),
      });
      const jobId = createHash("sha256")
        .update(`${p.projectId}:${invite.invitationId}`)
        .digest("hex");
      let message: any;
      for (let i = 0; i < 100; i++) {
        message = (
          await requireFunctions("firebase-admin/firestore")
            .getFirestore(adminApp)
            .doc(`emulatorMail/${jobId}`)
            .get()
        ).data();
        if (message) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(message, "email trigger delivered into local inbox");
      const url = new URL(
        message.text.split("Open your invitation:\n")[1].split("\n")[0],
      );
      const access = {
        projectId: p.projectId,
        invitationId: invite.invitationId,
        token: new URLSearchParams(url.hash.slice(1)).get("token"),
      };
      await signOut(auth);
      const info = await call("getProjectInvitation", access);
      assert.equal(info.role, "editor");
      const shared = await call("readSharedProject", access);
      assert.deepEqual(shared.draft.blocks, draft.blocks);
      await assert.rejects(call("acceptProjectInvitation", access), {
        code: "functions/unauthenticated",
      });
      const account = await createUserWithEmailAndPassword(
        auth,
        recipient,
        `test-${randomUUID()}`,
      );
      await assert.rejects(call("acceptProjectInvitation", access), {
        code: "functions/failed-precondition",
      });
      await requireFunctions("firebase-admin/auth")
        .getAuth(adminApp)
        .updateUser(account.user.uid, { emailVerified: true });
      await reload(account.user);
      await account.user.getIdToken(true);
      const accepted = await call("acceptProjectInvitation", access);
      assert.equal(accepted.role, "editor");
      const branch = await call("createBranch", {
        projectId: p.projectId,
        name: "invited-writer",
        sourceBranch: "main",
        expectedHead: result.commitId,
        requestId: randomUUID(),
      });
      assert.ok(branch.branchId);
      console.log(
        "PASS: email trigger → guest read → account required → verified acceptance → editor branch",
      );
    } finally {
      await adminApp.delete();
    }
    console.log(
      "PASS: authenticated callable → real Storage upload → finalize trigger → commit callable → Firestore trigger → Git revision read",
    );
  } finally {
    await deleteApp(app);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
