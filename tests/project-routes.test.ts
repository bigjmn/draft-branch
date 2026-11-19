import test from "node:test";
import assert from "node:assert/strict";
import {
  projectHref,
  projectStorageKey,
  validProjectId,
} from "../src/lib/projects/routes";
test("project links encode input and reject malformed IDs before database paths are formed", () => {
  assert.equal(projectHref("hello/world?"), "/editor?project=hello%2Fworld%3F");
  for (const value of [null, "", "../private", "a/b", "x?y", "a".repeat(129)])
    assert.equal(validProjectId(value), false);
  assert.equal(validProjectId("safe-project_123"), true);
});
test("recovery storage is isolated by account and project, separate from guest drafts", () => {
  const a = projectStorageKey("alice", "one");
  assert.notEqual(a, projectStorageKey("bob", "one"));
  assert.notEqual(a, projectStorageKey("alice", "two"));
  assert.notEqual(a, "draftbranch.editor.v1");
});

test("branch recovery keys preserve main compatibility and isolate alternate branches", () => {
  assert.equal(
    projectStorageKey("alice", "one", "main"),
    projectStorageKey("alice", "one"),
  );
  assert.notEqual(
    projectStorageKey("alice", "one", "alternate"),
    projectStorageKey("alice", "one", "main"),
  );
});
