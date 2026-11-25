import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTACT_EMAIL, contactErrorMessage } from "../src/lib/contact";

test("server messages are shown without the SDK's status suffix", () => {
  assert.equal(
    contactErrorMessage({
      code: "functions/resource-exhausted",
      message: "Please try again in an hour, or email directly. [429]",
    }),
    `Please try again in an hour, or email ${CONTACT_EMAIL}.`,
  );
  assert.equal(
    contactErrorMessage({
      code: "functions/invalid-argument",
      message: "Enter a valid email address. [400]",
    }),
    "Enter a valid email address.",
  );
});
test("other failures fall back to a generic message with the address", () => {
  for (const error of [
    { code: "functions/unavailable", message: "x [503]" },
    { code: "functions/internal", message: "internal [500]" },
    new Error("network"),
    null,
  ])
    assert.match(
      contactErrorMessage(error),
      new RegExp(CONTACT_EMAIL.replace(/\./g, "\\.")),
    );
});
