import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDesktopDownloads } from "../src/lib/downloads";

function folder(files: Record<string, number>) {
  const directory = mkdtempSync(join(tmpdir(), "draftbranch-downloads-"));
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(directory, name), Buffer.alloc(bytes));
  return directory;
}

test("no downloads folder means nothing is offered", () => {
  assert.deepEqual(
    findDesktopDownloads(join(tmpdir(), "no-such-folder-here")),
    {},
  );
  assert.deepEqual(findDesktopDownloads(folder({})), {});
});

test("installers in the folder become download links", () => {
  const found = findDesktopDownloads(
    folder({
      "DraftBranch-0.1.0-mac-universal.dmg": 2_600_000,
      "DraftBranch-0.1.0-win-x64.exe": 1_400_000,
    }),
  );
  assert.deepEqual(found, {
    mac: {
      href: "/downloads/DraftBranch-0.1.0-mac-universal.dmg",
      version: "0.1.0",
      size: "3 MB",
    },
    windows: {
      href: "/downloads/DraftBranch-0.1.0-win-x64.exe",
      version: "0.1.0",
      size: "1 MB",
    },
  });
});

test("one platform can be offered without the other", () => {
  const found = findDesktopDownloads(
    folder({ "DraftBranch-0.1.0-win-x64.exe": 1_000_000 }),
  );
  assert.equal(found.mac, undefined);
  assert.equal(found.windows?.version, "0.1.0");
});

test("the newest version wins, compared as numbers", () => {
  const found = findDesktopDownloads(
    folder({
      "DraftBranch-0.9.0-mac-universal.dmg": 1_000_000,
      "DraftBranch-0.10.0-mac-arm64.dmg": 1_000_000,
      "DraftBranch-0.2.5-mac-universal.dmg": 1_000_000,
      "DraftBranch-1.0.0-beta.2-win-x64.exe": 1_000_000,
      "DraftBranch-0.9.9-win-x64.exe": 1_000_000,
    }),
  );
  assert.equal(found.mac?.href, "/downloads/DraftBranch-0.10.0-mac-arm64.dmg");
  assert.equal(found.mac?.version, "0.10.0");
  assert.equal(found.windows?.version, "1.0.0-beta.2");
});

test("other files, empty files and folders are ignored", () => {
  const directory = folder({
    "DraftBranch-0.1.0-mac-universal.dmg": 0,
    "DraftBranch-0.1.0-win-x64.exe.blockmap": 5000,
    "DraftBranch-0.1.0-linux-x86_64.AppImage": 5000,
    "Something-0.1.0-win-x64.exe": 5000,
    "DraftBranch-mac.dmg": 5000,
    "notes.txt": 10,
  });
  mkdirSync(join(directory, "DraftBranch-9.9.9-win-x64.exe"));
  const found = findDesktopDownloads(directory);
  assert.equal(found.mac, undefined);
  assert.equal(found.windows, undefined);
});
