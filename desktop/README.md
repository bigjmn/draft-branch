# DraftBranch for desktop

The DraftBranch screenplay editor as a desktop application for macOS, Windows and Linux.

- **No account needed.** Create projects and write, commit, branch and merge with everything stored inside the app.
- **Sign in to pull your cloud projects.** A pulled project is a full copy on the computer: its screenplay, branches and revision history.
- **Works offline.** Keep writing, committing and branching without a connection. Sync publishes your revisions and brings in everyone else's when you are back online.
- **Same editor.** The desktop app runs the web app's own editor, version-control panel and merge tools from `../src`, so the two stay in step.

It is an [Electron](https://www.electronjs.org/) app in its own npm package. Nothing in the backend changes: the desktop app talks to DraftBranch cloud through the same callable functions and Firestore reads as the web app.

## Run it

The desktop app shares the web app's source and its libraries (React, Firebase, PDF.js, Tailwind), so install the repository root first.

```sh
# from the repository root, once
npm ci

cd desktop
npm install
npm run dev
```

`npm run dev` opens the app with live reload. Development builds keep their data in a separate folder (`DraftBranch (development)`), so experiments never touch a real library.

To run the production build instead:

```sh
npm run build
npm start
```

### Connecting to DraftBranch cloud

Sign-in and sync need the same Firebase web API key the web app is built with. The build reads it from, in order: the `DRAFTBRANCH_FIREBASE_API_KEY` or `NEXT_PUBLIC_FIREBASE_API_KEY` environment variable, `desktop/.env`, `../.env.local`, `../.env`. If you already run the web app locally, there is nothing to set up.

Without a key the app still builds and runs; projects on the device work, and the sign-in dialog explains that the build has no cloud connection.

To use the Firebase emulators instead of the live project, start them from the repository root as described in `../docs/backend.md`, then:

```sh
DRAFTBRANCH_USE_FIREBASE_EMULATORS=true npm run dev
```

## Build installers

```sh
npm run dist:mac     # release/DraftBranch-<version>-mac-<arch>.dmg and .zip
npm run dist:win     # release/DraftBranch-<version>-win-<arch>.exe (installer)
npm run dist:linux   # release/DraftBranch-<version>-linux-<arch>.AppImage and .tar.gz
npm run pack         # unpacked app in release/, for a quick look
```

Build each platform's installer on that platform. Add `--x64`, `--arm64` or (macOS) `--universal` after the command to choose an architecture, for example `npm run dist:mac -- --universal`.

There is no automatic update yet (`publish: null` in `electron-builder.yml`).

### Release: the installers the website offers

```sh
npm run release
```

Run it on a Mac. It builds the app once, then makes both installers:

- the Mac disk image, one file for Intel and Apple silicon (`DraftBranch-<version>-mac-universal.dmg`), signed and notarized when the certificate and credentials described below are in place;
- the Windows installer for 64-bit PCs (`DraftBranch-<version>-win-x64.exe`), which the Mac can build too.

Each one is copied to `../public/downloads/`, replacing the previous release's file. The site's Downloads page (`../src/app/downloads/page.tsx`) reads that folder when the site is built and turns each button into a link for the installer it finds, so rebuild and deploy the site after a release. The folder is git-ignored, because the installers are too large for the repository.

A Mac build that is not signed and notarized is built but not copied, because other Macs refuse to open it. `npm run release -- --allow-unsigned` copies it anyway, for trying the page on your own machine, and `--mac` or `--win` builds only one of the two. The run ends with a summary, and its full output is saved in `release/release.log`.

### Signing, for builds other people will download

Out of the box the installers are unsigned. That is fine on the computer that built them and not for a download link.

- **macOS.** With no certificate in the keychain, electron-builder leaves the app unsigned. It opens on the Mac that built it, but macOS refuses to open a copy downloaded on another Mac, and the warning has no button to open it anyway. Shipping it takes an Apple Developer Program membership and a _Developer ID Application_ certificate in your keychain. `npm run dist:mac` then signs the app by itself, and also notarizes it when Apple credentials are in the environment:

  ```sh
  export APPLE_ID="you@example.com"
  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # an app-specific password from your Apple Account
  export APPLE_TEAM_ID="XXXXXXXXXX"
  npm run dist:mac
  ```

  To skip the exports, keep the three values in `electron-builder.env` in this folder. electron-builder reads that file by itself, a value set in the shell wins over it, and it is git-ignored because it holds a password.

  An App Store Connect API key works instead of the Apple ID: `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The build log ends the step with `notarization successful`; `skipped macOS notarization` means the credentials were not found, and `skipped macOS application code signing` means the certificate was not. See electron-builder's [notarization guide](https://www.electron.build/docs/notarization).

- **Windows.** An unsigned installer is stopped by SmartScreen ("Windows protected your PC") until the person chooses **More info**, then **Run anyway**. Signing it is the way out, though a new certificate still has to earn a reputation before the warning goes away. See electron-builder's [code signing guide](https://www.electron.build/code-signing).
- **Linux.** Nothing to sign. An AppImage has to be marked executable before it runs.
- Consider turning on [Electron fuses](https://www.electron.build/docs/tutorials/adding-electron-fuses) (`runAsNode: false`, `enableNodeCliInspectArguments: false`, `onlyLoadAppFromAsar: true`) in `electron-builder.yml`.

### Icons

The app icon is the DraftBranch mark, the same drawing as the web app's tab icon (`../src/app/icon.svg`).

- `build/icon.png` is the macOS icon: the mark on Apple's icon grid, with the margin macOS expects. The disk image uses it for its mounted volume, and `npm run dev` puts it in the Dock.
- `build/icons/` holds the mark edge to edge, in the sizes Windows and Linux use.

To change the icon, replace those files and keep their sizes; `electron-builder.yml` says which platform reads which.

## Commands

| Command             | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Run the app with live reload                                    |
| `npm run build`     | Production build into `dist/`                                   |
| `npm start`         | Run the production build                                        |
| `npm run typecheck` | Type-check the desktop code and the shared web code it compiles |
| `npm test`          | Store, sync and backend-compatibility tests                     |
| `npm run format`    | Format with the repository's Prettier                           |
| `npm run dist:*`    | Build installers (see above)                                    |
| `npm run release`   | Build the installers the website offers (see above)             |

## Where projects are kept

Everything lives in the app's own data folder. **Settings** in the app shows the exact path and opens it.

| System  | Library folder                                      |
| ------- | --------------------------------------------------- |
| macOS   | `~/Library/Application Support/DraftBranch/library` |
| Windows | `%APPDATA%\DraftBranch\library`                     |
| Linux   | `~/.config/DraftBranch/library`                     |

```
library/
  settings.json
  local/<project>/             made on this device, no account
  accounts/<uid>/<project>/    pulled from DraftBranch cloud, per account
    project.json               title, role, sync bookkeeping
    state.json                 branches and what the cloud had at the last sync
    git/                       a bare Git repository
    drafts/                    working drafts, one per branch
```

Each project's history is a real Git repository in the same format the backend writes (`screenplay.json` in a one-file tree), so ordinary Git can read it:

```sh
git --git-dir "<library>/local/<project>/git" log --all --oneline
```

Files are written atomically (temporary file, flush, rename) with a backup of the previous version, so a crash or power cut mid-save cannot leave a half-written project. Back the library folder up like any other folder.

## How sync works

A pulled project keeps two things side by side: your branches, and what the cloud had when you last synced. Sync runs when you open a project, in the background while it is open, when the connection comes back, and whenever you choose **Sync**.

1. **Fetch.** New cloud revisions are rebuilt on the device byte for byte, so they keep the cloud's revision IDs. Screenplay text for older history downloads on demand.
2. **Bring in.** A branch with nothing new of its own moves forward to the cloud's version. A branch with unpublished revisions of its own is replayed on top of the cloud's, combining both sides with the same screenplay-aware merge the web app uses. If both sides changed the same element, you are asked which to keep.
3. **Publish.** Each unpublished revision is sent through the same save-then-commit calls the web app makes, in order, with its message. Branches made offline are created in the cloud.
4. **Working draft.** Uncommitted writing is synced both ways too, so you can pick up on the web where you left off.

Things worth knowing:

- A published revision takes the cloud's revision ID and timestamp; the copy made offline is replaced by it. The message, author and text are unchanged.
- The branch open in the editor is never moved underneath you. Background sync leaves it alone; **Sync** saves first, then reloads the editor with the result.
- Committing while online publishes straight away, as on the web.
- Merging branches, merge requests, sharing and comments in a **cloud** project happen on the server, so they need a connection. Projects kept only on the device merge locally.
- Roles are respected on the device: readers get a read-only copy, and only the owner can commit to `main`.
- If your access is removed, the copy on the device becomes read-only and stays readable.
- Signing out hides that account's projects but leaves them on disk; they return when the account signs in again.

## Signing in

Email and password sign in inside the app.

Google does not allow its sign-in inside an app window, so **Continue with Google** opens your browser on a page the app serves at `http://localhost:<random port>` for the duration of the sign-in. That page runs the normal Firebase Google sign-in and hands the Google credential straight back to the app. The listener accepts connections from this computer only, takes a single result protected by a one-time code, and shuts down as soon as it has it. `localhost` is an authorized domain in Firebase Authentication by default.

## How it is put together

```
src/
  core/        Pure TypeScript shared by both processes and the tests:
               snapshot format, commit graph, sync engine, cloud interface
  main/        Electron main process: window, menu, app:// protocol, IPC,
               Google sign-in listener, and the project store (store/)
  preload/     The one small bridge exposed to the page
  renderer/    The page: library, account and sync UI, plus the glue that
               runs the shared editor against the on-device store
  shared/      Types for the main <-> renderer bridge
tests/         Store, sync-engine and backend-compatibility tests
```

**Reusing the web app.** The renderer is built with Vite and imports the web app's components from `../src` through the `@/` alias. Two imports are redirected for this build (see `vite.config.mts` and `tsconfig.json`):

- `@/lib/projects/client` resolves to `src/renderer/data/client.ts`, which offers the same functions as the web app's project client but reads and writes the on-device repository. This is why the shared editor, version-control panel and merge workspace work offline without changes. `src/renderer/data/contract.ts` makes `npm run typecheck` fail if the web client gains or changes an export that the desktop client does not follow.
- `next/link` and `next/navigation` resolve to small stand-ins in `src/renderer/shims/`.

The shared components accept an optional `host` prop (`EditorHost` in `src/components/editor/screenplay-editor.tsx`) for the few places the desktop app differs: the back link, wording about where drafts are saved, and the sync button. The web app passes nothing and behaves as before.

**Security.** The page runs sandboxed with context isolation and no Node access. It is served from a private `app://draftbranch/` address with a strict content security policy; there is no local web server apart from the short-lived sign-in listener. Every request from the page to the main process is checked to come from the app's own page and is validated again by the store. Links open in your browser, never in the app window.

## Troubleshooting

**"This build was made without a Firebase API key."** See [Connecting to DraftBranch cloud](#connecting-to-draftbranch-cloud), then rebuild.

**Sign-in is blocked.** If the web API key is restricted to your site's addresses (HTTP referrers) in the Google Cloud console, Google rejects the desktop app, because a desktop app has no web address to send. Create a second API key for the desktop app, restrict it by API (Identity Toolkit, Token Service, Cloud Firestore, Cloud Storage for Firebase) instead of by website, and put it in `desktop/.env`:

```
DRAFTBRANCH_FIREBASE_API_KEY=your-desktop-key
```

**Google sign-in opens the browser but nothing happens.** Allow pop-ups for `localhost` in the browser, and check that `localhost` is still listed under Authentication → Settings → Authorized domains in the Firebase console.

**"The app has not been built."** Run `npm run build` before `npm start`.

**The desktop app says it needs the web app's dependencies.** Run `npm ci` in the repository root.

## Known limits

- A project made on the device cannot be uploaded to DraftBranch cloud yet. Export it and import the file into a new cloud project.
- Projects pulled on two computers sync through the cloud, not with each other.
- When there are new revisions, sync reads the project's whole list of revision records, which is fine for hundreds of revisions and worth revisiting for thousands.
- No automatic updates, and installers are unsigned (see [Build installers](#build-installers)).
