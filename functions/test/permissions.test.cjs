const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  canEditBranch,
  canBranchFrom,
  canMergeInto,
  canCommentOn,
  canModerateComments,
  editorAccess,
  describeAccess,
} = require("../lib/projects/permissions");
const { parseInviteOptions } = require("../lib/projects/service");
const { invitationMessage } = require("../lib/projects/mail");

const main = { name: "main", protected: true };
const shared = { name: "shared", protected: false, createdBy: "alice" };
const mine = { name: "bob-sub", protected: false, createdBy: "bob" };
const dedicated = {
  name: "bob-pages",
  protected: false,
  createdBy: "bob",
  dedicatedTo: "bob",
};
const owner = { role: "owner" };
const editor = (access) => ({ role: "editor", ...(access ? { access } : {}) });

test("owners edit every branch; readers and commenters edit none", () => {
  for (const branch of [main, shared, mine, dedicated])
    assert.equal(canEditBranch(owner, "alice", branch), true);
  for (const role of ["reviewer", "commenter"])
    for (const branch of [main, shared])
      assert.equal(canEditBranch({ role }, "dave", branch), false);
  assert.equal(canEditBranch(undefined, "x", shared), false);
});

test("editors edit main only when allowed; everyone else's branches otherwise", () => {
  const plain = editor(); // a membership from before options existed
  assert.equal(canEditBranch(plain, "carol", main), false);
  assert.equal(canEditBranch(plain, "carol", shared), true);
  assert.equal(canMergeInto(plain, "carol", main), false);
  const trusted = editor({ editMain: true, commentMain: true, branch: null });
  assert.equal(canEditBranch(trusted, "carol", main), true);
  assert.equal(canMergeInto(trusted, "carol", main), true);
  // Nobody but its editor (and the owner) writes on a dedicated branch.
  assert.equal(canEditBranch(trusted, "carol", dedicated), false);
  assert.equal(
    canBranchFrom(plain, "carol", dedicated),
    true,
    "but may branch from it",
  );
});

test("an editor with a dedicated branch writes only there and on branches they made", () => {
  const bob = editor({
    editMain: false,
    commentMain: true,
    branch: "bob-pages",
  });
  assert.equal(canEditBranch(bob, "bob", dedicated), true);
  assert.equal(canEditBranch(bob, "bob", mine), true);
  assert.equal(canEditBranch(bob, "bob", shared), false);
  assert.equal(canEditBranch(bob, "bob", main), false);
  // Even editMain can't open main to a restricted editor.
  assert.equal(
    canEditBranch(
      { role: "editor", access: { editMain: true, branch: "bob-pages" } },
      "bob",
      main,
    ),
    false,
  );
  assert.equal(canBranchFrom(bob, "bob", dedicated), true);
  assert.equal(canBranchFrom(bob, "bob", mine), true);
  assert.equal(canBranchFrom(bob, "bob", main), false);
  assert.equal(canBranchFrom(bob, "bob", shared), false);
  assert.equal(canMergeInto(bob, "bob", dedicated), true);
  assert.equal(canMergeInto(bob, "bob", main), false);
});

test("comments: owners and commenters anywhere, editors on main only if allowed, readers never", () => {
  assert.equal(canCommentOn(owner, main), true);
  assert.equal(canCommentOn({ role: "commenter" }, main), true);
  assert.equal(canCommentOn({ role: "reviewer" }, shared), false);
  assert.equal(canCommentOn(editor(), main), true, "allowed by default");
  assert.equal(canCommentOn(editor({ commentMain: false }), main), false);
  assert.equal(canCommentOn(editor({ commentMain: false }), shared), true);
  assert.equal(canModerateComments(owner), true);
  assert.equal(canModerateComments(editor()), false);
});

test("editor options default safely and describe themselves", () => {
  assert.deepEqual(editorAccess(editor()), {
    editMain: false,
    commentMain: true,
    branch: null,
  });
  assert.equal(
    describeAccess(editor({ branch: "bob-pages" })),
    "Editor · dedicated branch bob-pages",
  );
  assert.equal(
    describeAccess(editor({ editMain: true, commentMain: false })),
    "Editor · can edit main · no comments on main",
  );
  assert.equal(describeAccess({ role: "commenter" }), "Commenter");
});

test("invitation options are validated", () => {
  assert.deepEqual(parseInviteOptions("editor", {}), {
    access: { editMain: false, commentMain: true, branch: null },
    note: "",
    requireSignIn: false,
  });
  assert.deepEqual(
    parseInviteOptions("editor", {
      branch: "act-two",
      commentMain: false,
      note: " Hi ",
    }),
    {
      access: { editMain: false, commentMain: false, branch: "act-two" },
      note: "Hi",
      requireSignIn: false,
    },
  );
  assert.deepEqual(
    parseInviteOptions("commenter", { editMain: true, note: "Thanks" }),
    {
      access: null,
      note: "Thanks",
      requireSignIn: false,
    },
  );
  // Any role can require sign-in for read access. It's off unless asked for.
  assert.equal(
    parseInviteOptions("reviewer", { requireSignIn: true }).requireSignIn,
    true,
  );
  assert.throws(
    () => parseInviteOptions("reviewer", { requireSignIn: "yes" }),
    {
      code: "invalid-argument",
    },
  );
  for (const bad of [
    { branch: "act-two", editMain: true },
    { branch: "main" },
    { branch: "Act Two" },
    { editMain: "yes" },
    { note: "x".repeat(1001) },
  ])
    assert.throws(() => parseInviteOptions("editor", bad), {
      code: "invalid-argument",
    });
});

test("invitation emails say how the person was invited and include the note", () => {
  const base = {
    projectId: "p",
    invitationId: "i",
    to: "bob@example.com",
    ownerName: "Alice",
    title: "Pilot",
    link: "https://draftbranch.com/invite#token=x",
    attempts: 0,
  };
  const dedicatedMail = invitationMessage(
    {
      ...base,
      role: "editor",
      branch: "bob-pages",
      note: "Take act two.\nNo rush.",
    },
    "job",
  );
  assert.match(
    dedicatedMail.text,
    /^Alice invited you to edit “Pilot” with dedicated branch “bob-pages”\./,
  );
  assert.match(
    dedicatedMail.text,
    /A note from Alice:\n> Take act two\.\n> No rush\./,
  );
  assert.equal(
    dedicatedMail.subject,
    "Alice invited you to “Pilot” on DraftBranch",
  );
  assert.match(
    invitationMessage({ ...base, role: "commenter" }, "job").text,
    /^Alice invited you to comment on “Pilot”\./,
  );
  assert.match(
    invitationMessage({ ...base, role: "reviewer" }, "job").text,
    /^Alice invited you to read “Pilot”\./,
  );
  assert.doesNotMatch(
    invitationMessage({ ...base, role: "editor" }, "job").text,
    /A note from/,
  );
});

test("an invitation that requires sign-in doesn't offer reading without an account", () => {
  const base = {
    projectId: "p",
    invitationId: "i",
    to: "bob@example.com",
    ownerName: "Alice",
    title: "Pilot",
    link: "https://draftbranch.com/invite#token=x",
    attempts: 0,
  };
  for (const role of ["reviewer", "commenter", "editor"]) {
    const open = invitationMessage({ ...base, role }, "job").text;
    const locked = invitationMessage(
      { ...base, role, requireSignIn: true },
      "job",
    ).text;
    assert.match(open, /Anyone holding it can read/);
    assert.doesNotMatch(locked, /without an account|Anyone holding it/);
    assert.match(locked, /opens only for you, signed in with this email/);
    assert.match(locked, /Sign in or create an account with this email/);
  }
});
