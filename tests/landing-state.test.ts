import { test } from "node:test";
import assert from "node:assert/strict";
import { landingState } from "../src/lib/firebase/landing-state";
test("restored accounts go from loader to dashboard without rendering disabled landing controls", () => {
  assert.equal(landingState(true, null), "loading");
  assert.equal(landingState(true, { isAnonymous: false }), "loading");
  assert.equal(landingState(false, { isAnonymous: false }), "dashboard");
});
test("signed-out visitors and anonymous editor guests retain landing actions", () => {
  assert.equal(landingState(false, null), "landing");
  assert.equal(landingState(false, { isAnonymous: true }), "landing");
  assert.equal(landingState(false, { isAnonymous: false }), "dashboard");
  assert.equal(landingState(false, null), "landing");
});
