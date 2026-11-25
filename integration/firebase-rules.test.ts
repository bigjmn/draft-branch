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

test("comments follow roles: owners and commenters anywhere, editors off main only if allowed, readers never", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "projects/rules-project/branches/main"), {
      name: "main",
      protected: true,
    });
    await setDoc(doc(db, "projects/rules-project/branches/draft"), {
      name: "draft",
      protected: false,
    });
    await setDoc(doc(db, "projects/rules-project/members/commenter"), {
      role: "commenter",
    });
    await setDoc(doc(db, "projects/rules-project/members/quiet-editor"), {
      role: "editor",
      access: { editMain: false, commentMain: false, branch: null },
    });
  });
  const note = (uid: string, branch = "main") => ({
    authorUid: uid,
    authorName: uid,
    branch,
    blockId: "scene-1",
    quote: "INT. HOUSE - DAY",
    text: "Tighten this scene.",
    resolved: false,
    createdAt: serverTimestamp(),
  });
  const at = (uid: string, id: string) =>
    doc(user(uid).firestore(), `projects/rules-project/comments/${id}`);
  await assertSucceeds(setDoc(at("owner", "owner-note"), note("owner")));
  await assertSucceeds(setDoc(at("commenter", "c-note"), note("commenter")));
  // Editors comment on main by default (no access options recorded).
  await assertSucceeds(setDoc(at("editor", "e-note"), note("editor")));
  // An editor invited without main comments may still comment elsewhere.
  await assertFails(setDoc(at("quiet-editor", "q-main"), note("quiet-editor")));
  await assertSucceeds(
    setDoc(at("quiet-editor", "q-draft"), note("quiet-editor", "draft")),
  );
  await assertFails(setDoc(at("reviewer", "r-note"), note("reviewer")));
  await assertFails(setDoc(at("outsider", "o-note"), note("outsider")));
  // Nobody posts as someone else, or on a branch that doesn't exist.
  await assertFails(setDoc(at("editor", "forged"), note("owner")));
  await assertFails(
    setDoc(at("editor", "nowhere"), note("editor", "no-such-branch")),
  );
  await assertSucceeds(getDoc(at("reviewer", "owner-note")));
  await assertFails(getDoc(at("outsider", "owner-note")));

  // Authors edit and resolve their own; others can't touch them.
  await assertSucceeds(
    updateDoc(at("commenter", "c-note"), {
      text: "Tighten this scene a lot.",
      updatedAt: serverTimestamp(),
    }),
  );
  // Resolving, reopening and editing again after an edit (the stored
  // updatedAt is left alone unless the text changes).
  await assertSucceeds(
    updateDoc(at("commenter", "c-note"), { resolved: true }),
  );
  await assertSucceeds(
    updateDoc(at("commenter", "c-note"), { resolved: false }),
  );
  await assertSucceeds(
    updateDoc(at("commenter", "c-note"), {
      text: "Tighten this scene, please.",
      updatedAt: serverTimestamp(),
    }),
  );
  await assertSucceeds(
    updateDoc(at("commenter", "c-note"), { resolved: true }),
  );
  // The edit time can't be forged.
  await assertFails(
    updateDoc(at("commenter", "c-note"), {
      text: "Backdated.",
      updatedAt: new Date(2000, 0, 1),
    }),
  );
  await assertFails(updateDoc(at("editor", "c-note"), { text: "Mine now." }));
  await assertFails(updateDoc(at("commenter", "c-note"), { text: "" }));
  await assertFails(
    updateDoc(at("commenter", "c-note"), { authorUid: "editor" }),
  );
  // The owner moderates: resolves and deletes anyone's, but can't reword them.
  await assertSucceeds(updateDoc(at("owner", "e-note"), { resolved: true }));
  await assertFails(updateDoc(at("owner", "e-note"), { text: "Reworded." }));
  await assertFails(deleteDoc(at("commenter", "e-note")));
  await assertSucceeds(deleteDoc(at("editor", "e-note")));
  await assertSucceeds(deleteDoc(at("owner", "c-note")));
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
