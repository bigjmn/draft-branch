// Release build: the installers people download from the website.
//
//   npm run release              on a Mac: the Mac disk image and the Windows installer
//   npm run release -- --mac     only the Mac build (needs a Mac)
//   npm run release -- --win     only the Windows installer
//
// Each finished installer is copied to ../public/downloads/, where the site's
// Downloads page finds it. A Mac build that is not signed and notarized is
// built but not copied, because other Macs refuse to open it. Add
// --allow-unsigned to copy it anyway, for trying the page on your own machine.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  developerId,
  hasWindowsSignature,
  installerNames,
  installerPlatform,
  macVerdict,
  maskSecrets,
  megabytes,
} from "./release-lib.mjs";
import { desktop } from "./shared.mjs";

const OPTIONS = ["--mac", "--win", "--allow-unsigned"];
const options = process.argv.slice(2);
const unknown = options.filter((option) => !OPTIONS.includes(option));
if (unknown.length)
  stop(`Unknown option: ${unknown.join(" ")}\nOptions: ${OPTIONS.join(" ")}`);

const onMac = process.platform === "darwin";
const only = options.filter((option) => option !== "--allow-unsigned");
const wantMac = only.length ? only.includes("--mac") : onMac;
const wantWin = only.length
  ? only.includes("--win")
  : onMac || process.platform === "win32";
const allowUnsigned = options.includes("--allow-unsigned");
if (wantMac && !onMac) stop("The Mac build has to be made on a Mac.");
if (!wantMac && !wantWin)
  stop(
    "Run this on a Mac (it builds both installers) or on Windows (it builds the Windows one).",
  );
if (process.env.DRAFTBRANCH_USE_FIREBASE_EMULATORS === "true")
  stop(
    "DRAFTBRANCH_USE_FIREBASE_EMULATORS is set, so this build would talk to the local emulators. Unset it for a release.",
  );
if (!hasFirebaseKey())
  stop(
    "No Firebase web API key found, so the app could not sign in or sync.\n" +
      "Set NEXT_PUBLIC_FIREBASE_API_KEY in ../.env.local (see ../.env.example) and run this again.",
  );

const { version, productName } = JSON.parse(
  readFileSync(join(desktop, "package.json"), "utf8"),
);
const names = installerNames(version);
const release = join(desktop, "release");
const downloads = join(desktop, "..", "public", "downloads");
const builder = join(desktop, "node_modules", "electron-builder", "cli.js");
// The packager uploads builds when an npm script is called "release". This
// script only builds: the website serves the installers from its own folder.
const LOCAL_ONLY = ["--publish", "never"];
// Present on an Apple silicon Mac once Rosetta is installed.
const ROSETTA = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
const log = createWriteStream(join(release, "release.log"));

heading("Building the app");
if (
  (await run(process.execPath, ["scripts/check-root.mjs"])) !== 0 ||
  (await run(process.execPath, ["scripts/build.mjs"])) !== 0
)
  stop("The app did not build, so no installer was made.");

const results = [];
if (wantMac) results.push(await buildMac());
if (wantWin) results.push(await buildWindows());

const lines = [`${productName} ${version}`];
for (const result of results) {
  lines.push(
    `  ${result.platform}: ${result.file}${result.bytes ? `, ${megabytes(result.bytes)}` : ""}`,
    `    ${result.status}`,
    `    ${result.published ? "copied to public/downloads/" : `NOT copied to public/downloads/${result.built ? " (--allow-unsigned copies it anyway)" : ""}`}`,
  );
}
const complete = results.every((result) => result.published);
lines.push(
  complete
    ? "The site's Downloads page offers what is in public/downloads/ the next time the site is built."
    : "Not everything was published. The full build output is in release/release.log.",
);
heading("Release summary");
say(lines.join("\n"));
writeFileSync(
  join(release, "summary.json"),
  JSON.stringify({ version, complete, results }, null, 2) + "\n",
);
await new Promise((done) => log.end(done));
process.exit(complete ? 0 : 1);

async function buildMac() {
  heading("Mac: one disk image for Intel and Apple silicon");
  const result = { platform: "Mac", file: names.mac };
  const code = await run(process.execPath, [
    builder,
    "--mac",
    "dmg",
    "--universal",
    ...LOCAL_ONLY,
  ]);
  const image = join(release, names.mac);
  if (code !== 0 || !existsSync(image))
    return { ...result, built: false, status: "the build failed" };
  const app = join(release, "mac-universal", `${productName}.app`);
  const verdict = macVerdict({
    signedBy: developerId(
      capture("codesign", ["-dv", "--verbose=4", app]).text,
    ),
    signatureValid:
      capture("codesign", ["--verify", "--deep", "--strict", app]).status === 0,
    notarized: capture("xcrun", ["stapler", "validate", app]).status === 0,
  });
  const published = verdict.publishable || allowUnsigned;
  if (published) publish("mac", image);
  return {
    ...result,
    built: true,
    bytes: statSync(image).size,
    signed: verdict.publishable,
    status: verdict.publishable
      ? verdict.status
      : `${verdict.status}: other Macs will refuse to open it (README, "Signing")`,
    published,
  };
}

async function buildWindows() {
  heading("Windows: installer for 64-bit PCs");
  const result = { platform: "Windows", file: names.win };
  const command = [builder, "--win", "nsis", "--x64", ...LOCAL_ONLY];
  // The packager's stock installer compiler is an Intel program. On an Apple
  // silicon Mac without Rosetta, use its newer bundle, which has a native one.
  if (onMac && process.arch === "arm64" && !existsSync(ROSETTA))
    command.push("-c.toolsets.nsis=1.2.1");
  const code = await run(process.execPath, command);
  const installer = join(release, names.win);
  if (code !== 0 || !existsSync(installer))
    return { ...result, built: false, status: "the build failed" };
  const signed = hasWindowsSignature(firstBytes(installer, 4096));
  publish("win", installer);
  return {
    ...result,
    built: true,
    bytes: statSync(installer).size,
    signed,
    status: signed
      ? "code-signed"
      : "not code-signed: Windows shows a SmartScreen warning before it runs",
    published: true,
  };
}

/** Puts an installer where the website serves it, replacing the previous
 * release's installer for the same platform. */
function publish(platform, file) {
  mkdirSync(downloads, { recursive: true });
  for (const name of readdirSync(downloads))
    if (installerPlatform(name) === platform) rmSync(join(downloads, name));
  copyFileSync(file, join(downloads, names[platform]));
}

/** Same lookup as vite.config.mts, which is what puts the key into the app. */
function hasFirebaseKey() {
  if (
    process.env.DRAFTBRANCH_FIREBASE_API_KEY ||
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  )
    return true;
  return [
    join(desktop, ".env"),
    join(desktop, "..", ".env.local"),
    join(desktop, "..", ".env"),
  ].some((file) => {
    try {
      return /^\s*(?:DRAFTBRANCH_FIREBASE_API_KEY|NEXT_PUBLIC_FIREBASE_API_KEY)\s*=\s*\S/m.test(
        readFileSync(file, "utf8"),
      );
    } catch {
      return false;
    }
  });
}

/** Runs a command, showing its output here and saving it to release.log. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: desktop,
      stdio: ["inherit", "pipe", "pipe"],
    });
    for (const [stream, screen] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      stream.on("data", (chunk) => {
        screen.write(chunk);
        log.write(maskSecrets(String(chunk)));
      });
    child.on("error", (error) => {
      say(String(error));
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Runs a quick check and returns what it printed. */
function capture(command, args) {
  const done = spawnSync(command, args, { encoding: "utf8" });
  const text = `${done.stdout ?? ""}${done.stderr ?? ""}`;
  log.write(`\n$ ${command} ${args.join(" ")}\n${text}`);
  return { status: done.status ?? 1, text };
}

function firstBytes(file, count) {
  const buffer = Buffer.alloc(count);
  const handle = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(handle, buffer, 0, count, 0));
  } finally {
    closeSync(handle);
  }
}

function say(text) {
  console.log(text);
  log.write(text + "\n");
}

function heading(text) {
  say(`\n=== ${text} ===`);
}

function stop(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}
