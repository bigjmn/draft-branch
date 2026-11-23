import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  Timestamp,
  serverTimestamp,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";
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

test("mail queue, token-bearing emulator inbox and invitation quotas are never client-readable or writable", async () => {
  for (const context of [
    user("owner"),
    user("editor"),
    env.unauthenticatedContext(),
  ]) {
    for (const path of [
      "invitationMail/test",
      "invitationLimits/test",
      "emulatorMail/test",
    ]) {
      await assertFails(getDoc(doc(context.firestore(), path)));
      await assertFails(
        setDoc(doc(context.firestore(), path), { link: "forged" }),
      );
    }
  }
});
test("merge requests are readable by members and written only by the server", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(context.firestore(), "projects/rules-project/mergeRequests/mr1"),
      { status: "open", authorUid: "editor" },
    );
  });
  for (const uid of ["owner", "editor", "reviewer"])
    await assertSucceeds(
      getDoc(
        doc(user(uid).firestore(), "projects/rules-project/mergeRequests/mr1"),
      ),
    );
  await assertFails(
    getDoc(
      doc(
        user("outsider").firestore(),
        "projects/rules-project/mergeRequests/mr1",
      ),
    ),
  );
  await assertFails(
    setDoc(
      doc(
        user("owner").firestore(),
        "projects/rules-project/mergeRequests/mr1",
      ),
      { status: "merged" },
    ),
  );
});

test("profiles are publicly readable but writable only by their registered owner", async () => {
  const profile = {
    name: "Writer",
    job: "Screenwriter",
    company: "Studio",
    bio: "Hello.",
    avatarId: "",
    updatedAt: serverTimestamp(),
  };
  const path = "profiles/profile-owner";
  await assertSucceeds(
    setDoc(doc(user("profile-owner").firestore(), path), profile),
  );
  await assertSucceeds(
    getDoc(doc(env.unauthenticatedContext().firestore(), path)),
  );
  await assertFails(
    setDoc(doc(user("outsider").firestore(), path), {
      ...profile,
      name: "Impersonator",
    }),
  );
  await assertFails(
    setDoc(doc(env.unauthenticatedContext().firestore(), path), profile),
  );
  await assertFails(
    setDoc(
      doc(
        env
          .authenticatedContext("guest-profile", {
            firebase: { sign_in_provider: "anonymous", identities: {} },
          })
          .firestore(),
        "profiles/guest-profile",
      ),
      profile,
    ),
  );
  await assertFails(
    setDoc(doc(user("profile-owner").firestore(), path), {
      ...profile,
      bio: "x".repeat(501),
    }),
  );
  await assertFails(
    setDoc(doc(user("profile-owner").firestore(), path), {
      ...profile,
      role: "admin",
    }),
  );
  await assertFails(
    setDoc(doc(user("profile-owner").firestore(), path), {
      ...profile,
      avatarId: "../someone-else",
    }),
  );
});

test("avatars permit owner image uploads and public reads, not other writers or unsafe types", async () => {
  const path = "avatars/avatar-owner/12345678-1234-1234-1234-123456789abc.png";
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await assertSucceeds(
    uploadBytes(ref(user("avatar-owner").storage(), path), bytes, {
      contentType: "image/png",
    }),
  );
  await assertSucceeds(
    getBytes(ref(env.unauthenticatedContext().storage(), path)),
  );
  await assertFails(
    uploadBytes(ref(user("outsider").storage(), path), bytes, {
      contentType: "image/png",
    }),
  );
  await assertFails(
    uploadBytes(
      ref(
        user("avatar-owner").storage(),
        "avatars/avatar-owner/22345678-1234-1234-1234-123456789abc.png",
      ),
      bytes,
      { contentType: "image/svg+xml" },
    ),
  );
  await assertFails(
    uploadBytes(
      ref(
        user("avatar-owner").storage(),
        "avatars/avatar-owner/32345678-1234-1234-1234-123456789abc.png",
      ),
      new Uint8Array(2 * 1024 * 1024 + 1),
      { contentType: "image/png" },
    ),
  );
});

test("only owners create and resolve anchored comments; members can read", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(context.firestore(), "projects/rules-project/branches/main"),
      { name: "main" },
    );
  });
  const path = "projects/rules-project/comments/owner-note";
  const note = {
    authorUid: "owner",
    authorName: "Owner",
    branch: "main",
    blockId: "scene-1",
    quote: "INT. HOUSE - DAY",
    text: "Tighten this scene.",
    resolved: false,
    createdAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(doc(user("owner").firestore(), path), note));
  await assertSucceeds(getDoc(doc(user("editor").firestore(), path)));
  await assertFails(
    setDoc(
      doc(user("editor").firestore(), "projects/rules-project/comments/forged"),
      { ...note, authorUid: "editor" },
    ),
  );
  await assertFails(getDoc(doc(user("outsider").firestore(), path)));
  await assertSucceeds(
    updateDoc(doc(user("owner").firestore(), path), { resolved: true }),
  );
  await assertFails(
    updateDoc(doc(user("editor").firestore(), path), { resolved: false }),
  );
  await assertFails(
    updateDoc(doc(user("owner").firestore(), path), { authorUid: "editor" }),
  );
  await assertSucceeds(deleteDoc(doc(user("owner").firestore(), path)));
});
test("deleting projects reject member reads and new comments immediately", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "projects/deleting-project"), {
      title: "Gone",
      deleting: true,
    });
    await setDoc(
      doc(context.firestore(), "projects/deleting-project/members/owner"),
      { role: "owner" },
    );
  });
  await assertFails(
    getDoc(doc(user("owner").firestore(), "projects/deleting-project")),
  );
  await assertFails(
    setDoc(
      doc(user("owner").firestore(), "projects/deleting-project/comments/new"),
      { text: "Late note" },
    ),
  );
  await assertFails(
    setDoc(doc(user("owner").firestore(), "projectDeletions/forged"), {
      status: "queued",
    }),
  );
});
