const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseContact, contactMessage, CONTACT_TO } = require("../lib/contact");

test("contact form input is trimmed and validated", () => {
  assert.deepEqual(
    parseContact({
      name: "  Ada\nLovelace ",
      email: " ada@example.com ",
      subject: " Bug:\n export ",
      message: " Hi!\r\nThanks ",
      website: "",
    }),
    {
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: "Bug: export",
      message: "Hi!\nThanks",
    },
  );
  const ok = { name: "A", email: "a@b.co", subject: "Hi", message: "x" };
  for (const bad of [
    { ...ok, name: "" },
    { ...ok, email: "not an email" },
    { ...ok, email: "a@b.co\nBcc: x@y.z" },
    { ...ok, subject: "  " },
    { ...ok, subject: "x".repeat(151) },
    { ...ok, message: "   " },
    { ...ok, message: "x".repeat(5001) },
    { ...ok, name: "x".repeat(101) },
    null,
  ])
    assert.throws(() => parseContact(bad), { code: "invalid-argument" });
});

test("a filled hidden field marks a bot and is dropped silently", () => {
  assert.equal(
    parseContact({
      name: "Bot",
      email: "b@o.t",
      message: "spam",
      website: "http://spam",
    }),
    null,
  );
});

test("the email goes to the site owner with Reply-To set to the visitor", () => {
  const message = contactMessage({
    name: 'Ada "The" Countess',
    email: "ada@example.com",
    subject: "Feature idea: index cards",
    message: "Love the app.",
  });
  assert.equal(message.to, CONTACT_TO);
  assert.equal(message.replyTo, "Ada The Countess <ada@example.com>");
  assert.equal(
    message.subject,
    "DraftBranch contact: Feature idea: index cards",
  );
  assert.match(message.text, /^Love the app\.\n/);
  assert.match(message.text, /From: Ada "The" Countess <ada@example.com>/);
  assert.match(
    message.messageId,
    /^<draftbranch-contact-[0-9a-f-]+@draftbranch\.com>$/,
  );
});

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
test(
  "sends are limited per sender per hour and per day",
  { skip: !enabled },
  async () => {
    const { initializeApp, deleteApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const { claimContactQuota, CONTACT_LIMITS } = require("../lib/contact");
    const app = initializeApp(
      { projectId: "demo-draftbranch" },
      "contact-tests",
    );
    const db = getFirestore(app);
    try {
      const now = Date.UTC(2031, 0, 5, 12);
      for (let i = 0; i < CONTACT_LIMITS.perSenderPerHour; i++)
        await claimContactQuota(db, "203.0.113.9", now + i);
      await assert.rejects(claimContactQuota(db, "203.0.113.9", now + 10), {
        code: "resource-exhausted",
      });
      // An hour later the same sender may send again; others were never blocked.
      await claimContactQuota(db, "203.0.113.9", now + 60 * 60 * 1000 + 1);
      await claimContactQuota(db, "198.51.100.7", now + 20);
      const ids = (await db.collection("contactLimits").listDocuments()).map(
        (d) => d.id,
      );
      assert.ok(
        !ids.some((id) => id.includes("203.0.113.9")),
        "IP addresses are stored hashed",
      );
      // The daily cap applies across senders.
      const day = Date.UTC(2031, 0, 6, 12);
      for (let i = 0; i < CONTACT_LIMITS.perDay; i++)
        await claimContactQuota(db, `10.0.${i}.1`, day + i);
      await assert.rejects(claimContactQuota(db, "10.9.9.9", day + 500), {
        code: "resource-exhausted",
      });
    } finally {
      await deleteApp(app);
    }
  },
);
