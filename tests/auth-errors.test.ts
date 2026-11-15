import assert from "node:assert/strict";
import { test } from "node:test";
import { authErrorMessage } from "../src/lib/firebase/auth-errors";

test("cancelled Google popups show no error", () => {
  assert.equal(authErrorMessage({ code: "auth/popup-closed-by-user" }), null);
  assert.equal(
    authErrorMessage({ code: "auth/cancelled-popup-request" }),
    null,
  );
});
test("wrong credentials do not reveal whether the account exists", () => {
  const message = authErrorMessage({ code: "auth/invalid-credential" });
  assert.equal(authErrorMessage({ code: "auth/user-not-found" }), message);
  assert.equal(authErrorMessage({ code: "auth/wrong-password" }), message);
});
test("unknown errors fall back to a generic message", () => {
  assert.match(authErrorMessage(new Error("boom"))!, /try again/);
  assert.match(authErrorMessage(undefined)!, /try again/);
});
