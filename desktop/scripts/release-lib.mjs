// The parts of the release script that only compute things, kept apart so they
// can be tested (tests/release.test.ts).

/** The names electron-builder gives the two installers, from `artifactName`
 * in electron-builder.yml. The website's Downloads page looks for the same
 * shape (../src/lib/downloads.ts), so change the three together. */
export function installerNames(version) {
  return {
    mac: `DraftBranch-${version}-mac-universal.dmg`,
    win: `DraftBranch-${version}-win-x64.exe`,
  };
}

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;
const INSTALLERS = {
  mac: new RegExp(`^DraftBranch-${VERSION}-mac-[0-9a-z_]+\\.dmg$`),
  win: new RegExp(`^DraftBranch-${VERSION}-win-[0-9a-z_]+\\.exe$`),
};

/** Which platform a file in public/downloads/ is an installer for, or null
 * when it is not one of ours. A new release replaces the old file of its kind
 * and leaves everything else in the folder alone. */
export function installerPlatform(fileName) {
  for (const [platform, pattern] of Object.entries(INSTALLERS))
    if (pattern.test(fileName)) return platform;
  return null;
}

/** Who signed a Mac app, read from `codesign -dv --verbose=4`. Only a
 * Developer ID signature counts: it is the one other Macs accept. */
export function developerId(codesignOutput) {
  const match = /^Authority=(Developer ID Application: .+)$/m.exec(
    codesignOutput,
  );
  return match ? match[1].trim() : null;
}

/** Whether a Mac build can go on a download page. Without a Developer ID
 * signature and Apple's notarization, macOS refuses to open a downloaded copy. */
export function macVerdict({ signedBy, signatureValid, notarized }) {
  if (!signedBy)
    return {
      publishable: false,
      status: "not signed with a Developer ID certificate",
    };
  if (!signatureValid)
    return {
      publishable: false,
      status: `signed by ${signedBy}, but the signature does not verify`,
    };
  if (!notarized)
    return {
      publishable: false,
      status: `signed by ${signedBy}, but not notarized`,
    };
  return { publishable: true, status: `signed by ${signedBy} and notarized` };
}

/** Whether a Windows program carries a code signature. Takes the first few
 * kilobytes of the file: the answer is in the table of contents at its start
 * (a non-empty "certificate table" entry in the PE header). */
export function hasWindowsSignature(header) {
  if (header.length < 0x40 || header.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = header.readUInt32LE(0x3c);
  if (pe + 24 + 2 > header.length || header.readUInt32LE(pe) !== 0x4550)
    return false;
  const optional = pe + 24;
  const magic = header.readUInt16LE(optional);
  const directories =
    magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : -1;
  const certificateTable = directories + 4 * 8;
  if (directories < 0 || certificateTable + 8 > header.length) return false;
  return header.readUInt32LE(certificateTable + 4) > 0;
}

/** File size the way a download page states it. */
export function megabytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Keeps an Apple app-specific password out of the saved build log, should a
 * tool ever echo it. */
export function maskSecrets(text) {
  return text.replace(/\b[a-z]{4}(?:-[a-z]{4}){3}\b/g, "****-****-****-****");
}
