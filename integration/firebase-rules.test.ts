import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import { ref, uploadBytes, getBytes } from "firebase/storage";
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-draftbranch",
    firestore: { rules: await readFile("firestore.rules", "utf8") },
    storage: { rules: await readFile("storage.rules", "utf8") },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "projects/rules-project"), { title: "Private" });
    for (const [uid, role] of [
      ["owner", "owner"],
      ["editor", "editor"],
      ["reviewer", "reviewer"],
    ]) {
      await setDoc(doc(db, `projects/rules-project/members/${uid}`), { role });
      await setDoc(doc(db, `projects/rules-project/uploads/${uid}`), {
        actorUid: uid,
        status: "awaiting_upload",
        expiresAt: Timestamp.fromMillis(Date.now() + 600000),
        path: `projects/rules-project/uploads/${uid}/${uid}`,
      });
    }
    await setDoc(
      doc(db, "projects/rules-project/workingDrafts/editor/branches/main"),
      { version: 1 },
    );
  });
});
after(async () => {
  await env?.cleanup();
});
const user = (uid: string) =>
  env.authenticatedContext(uid, {
    firebase: { sign_in_provider: "password", identities: {} },
  });
test("members can read project metadata; outsiders and anonymous clients cannot", async () => {
  await assertSucceeds(
    getDoc(doc(user("editor").firestore(), "projects/rules-project")),
  );
  await assertFails(
    getDoc(doc(user("outsider").firestore(), "projects/rules-project")),
  );
  await assertFails(
    getDoc(
      doc(env.unauthenticatedContext().firestore(), "projects/rules-project"),
    ),
  );
});
test("clients cannot forge memberships, refs, commits or project records", async () => {
  for (const path of [
    "projects/forged",
    "projects/rules-project/members/outsider",
    "projects/rules-project/branches/main",
    "projects/rules-project/commits/forged",
  ]) {
    await assertFails(
      setDoc(doc(user("owner").firestore(), path), {
        role: "owner",
        head: "forged",
      }),
    );
  }
});
test("working drafts are private even from other project members", async () => {
  const path = "projects/rules-project/workingDrafts/editor/branches/main";
  await assertSucceeds(getDoc(doc(user("editor").firestore(), path)));
  await assertFails(getDoc(doc(user("owner").firestore(), path)));
});
test("staging uploads need a writer ticket, JSON mime, correct identity, and cannot be overwritten", async () => {
  const bytes = new TextEncoder().encode("{}");
  const metadata = { contentType: "application/json" };
  const path = "projects/rules-project/uploads/editor/editor";
  await assertFails(
    uploadBytes(
      ref(
        user("reviewer").storage(),
        "projects/rules-project/uploads/reviewer/reviewer",
      ),
      bytes,
      metadata,
    ),
  );
  await assertFails(
    uploadBytes(ref(user("outsider").storage(), path), bytes, metadata),
  );
  await assertFails(
    uploadBytes(
      ref(
        user("editor").storage(),
        "projects/rules-project/uploads/editor/no-ticket",
      ),
      bytes,
      metadata,
    ),
  );
  await assertFails(
    uploadBytes(ref(user("editor").storage(), path), bytes, {
      contentType: "text/plain",
    }),
  );
  await assertSucceeds(
    uploadBytes(ref(user("editor").storage(), path), bytes, metadata),
  );
  await assertFails(
    uploadBytes(ref(user("editor").storage(), path), bytes, metadata),
  );
  await assertFails(getBytes(ref(user("editor").storage(), path)));
});
test("canonical drafts and Git objects are not directly accessible", async () => {
  for (const path of [
    "projects/rules-project/git/objects/aa/123",
    "projects/rules-project/drafts/editor/123.json",
  ]) {
    await assertFails(
      uploadBytes(ref(user("owner").storage(), path), new Uint8Array([1])),
    );
    await assertFails(getBytes(ref(user("owner").storage(), path)));
  }
});
