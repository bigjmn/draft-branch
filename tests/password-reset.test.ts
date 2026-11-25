import { test } from "node:test";
import assert from "node:assert/strict";
import { signInUrl } from "../src/lib/firebase/password-reset";

test("the reset page links back to Sign in on the website", () => {
  assert.equal(
    signInUrl("https://draftbranch.com"),
    "https://draftbranch.com/?signin#account",
  );
  assert.equal(
    signInUrl("http://localhost:3000"),
    "http://localhost:3000/?signin#account",
  );
});
test("app origins that aren't web addresses get no continue link", () => {
  assert.equal(signInUrl("app://draftbranch"), undefined);
  assert.equal(signInUrl("null"), undefined);
});
