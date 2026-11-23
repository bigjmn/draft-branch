/** The release script decides what may go on the website's download page.
 * These cover the decisions; the builds themselves need a Mac. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  developerId,
  hasWindowsSignature,
  installerNames,
  installerPlatform,
  macVerdict,
  maskSecrets,
  megabytes,
} from "../scripts/release-lib.mjs";

test("installer names follow the packager's artifactName", () => {
  assert.deepEqual(installerNames("0.1.0"), {
    mac: "DraftBranch-0.1.0-mac-universal.dmg",
    win: "DraftBranch-0.1.0-win-x64.exe",
  });
});

test("only DraftBranch installers in the downloads folder are replaced", () => {
  const names = installerNames("1.2.3");
  assert.equal(installerPlatform(names.mac), "mac");
  assert.equal(installerPlatform(names.win), "win");
  assert.equal(installerPlatform("DraftBranch-0.9.0-mac-arm64.dmg"), "mac");
  assert.equal(
    installerPlatform("DraftBranch-2.0.0-beta.1-win-x64.exe"),
    "win",
  );
  for (const other of [
    "README.md",
    ".gitkeep",
    "DraftBranch-0.1.0-win-x64.exe.blockmap",
    "DraftBranch-0.1.0-linux-x86_64.AppImage",
    "Other-1.0.0-mac-universal.dmg",
    "DraftBranch-mac.dmg",
  ])
    assert.equal(installerPlatform(other), null, other);
});

const SIGNED = `Executable=/x/DraftBranch.app/Contents/MacOS/DraftBranch
Identifier=com.draftbranch.desktop
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=759 flags=0x10000(runtime) hashes=13+7 location=embedded
Authority=Developer ID Application: Example Person (AB12CD34EF)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 23, 2026 at 03:30:00
TeamIdentifier=AB12CD34EF
`;
const AD_HOC = `Executable=/x/DraftBranch.app/Contents/MacOS/DraftBranch
Identifier=Electron
CodeDirectory v=20400 size=500 flags=0x20002(adhoc,linker-signed) hashes=12+0 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;
const DEVELOPMENT = SIGNED.replace(
  "Developer ID Application: Example Person (AB12CD34EF)",
  "Apple Development: Example Person (ZZ99ZZ99ZZ)",
);

test("only a Developer ID signature counts as signed", () => {
  assert.equal(
    developerId(SIGNED),
    "Developer ID Application: Example Person (AB12CD34EF)",
  );
  assert.equal(developerId(AD_HOC), null);
  assert.equal(developerId(DEVELOPMENT), null);
  assert.equal(developerId("code object is not signed at all"), null);
  assert.equal(developerId(""), null);
});

test("a Mac build is publishable only when signed, valid and notarized", () => {
  const signedBy = developerId(SIGNED);
  assert.deepEqual(
    macVerdict({ signedBy, signatureValid: true, notarized: true }),
    {
      publishable: true,
      status:
        "signed by Developer ID Application: Example Person (AB12CD34EF) and notarized",
    },
  );
  const cases = [
    { signedBy: null, signatureValid: false, notarized: false },
    { signedBy: null, signatureValid: true, notarized: true },
    { signedBy, signatureValid: false, notarized: true },
    { signedBy, signatureValid: true, notarized: false },
  ];
  for (const facts of cases) {
    const verdict = macVerdict(facts);
    assert.equal(verdict.publishable, false, JSON.stringify(facts));
    assert.ok(verdict.status.length > 0);
  }
  assert.match(
    macVerdict({ signedBy, signatureValid: true, notarized: false }).status,
    /not notarized/,
  );
  assert.match(
    macVerdict({ signedBy: null, signatureValid: false, notarized: false })
      .status,
    /not signed/,
  );
});

/** A minimal Windows program header with the given certificate-table size. */
function programHeader(bits: 32 | 64, certificateBytes: number) {
  const header = Buffer.alloc(1024);
  header.writeUInt16LE(0x5a4d, 0); // "MZ"
  header.writeUInt32LE(0x80, 0x3c);
  header.writeUInt32LE(0x4550, 0x80); // "PE\0\0"
  const optional = 0x80 + 24;
  header.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, optional);
  const directories = optional + (bits === 64 ? 112 : 96);
  header.writeUInt32LE(certificateBytes ? 0x5000 : 0, directories + 4 * 8);
  header.writeUInt32LE(certificateBytes, directories + 4 * 8 + 4);
  return header;
}

test("a Windows program counts as signed only with a certificate table", () => {
  assert.equal(hasWindowsSignature(programHeader(32, 0)), false);
  assert.equal(hasWindowsSignature(programHeader(64, 0)), false);
  assert.equal(hasWindowsSignature(programHeader(32, 9000)), true);
  assert.equal(hasWindowsSignature(programHeader(64, 9000)), true);
  assert.equal(hasWindowsSignature(Buffer.from("not a program")), false);
  assert.equal(hasWindowsSignature(Buffer.alloc(0)), false);
  assert.equal(
    hasWindowsSignature(programHeader(32, 9000).subarray(0, 200)),
    false,
  );
});

test("sizes are whole megabytes", () => {
  assert.equal(megabytes(121_173_426), "121 MB");
  assert.equal(megabytes(230_600_000), "231 MB");
  assert.equal(megabytes(12), "1 MB");
});

test("an app-specific password never reaches the saved log", () => {
  assert.equal(
    maskSecrets("notarytool --password abcd-efgh-ijkl-mnop --team-id X"),
    "notarytool --password ****-****-****-**** --team-id X",
  );
  const harmless = "built DraftBranch-0.1.0-mac-universal.dmg in mac-universal";
  assert.equal(maskSecrets(harmless), harmless);
});
