# DraftBranch

A screenplay editor for film and television, with a long-term goal of bringing Git-style version control and private collaboration to writing projects.

The writing experience should feel familiar to users of Final Draft or WriterDuet. The collaboration model should let writers create alternate versions, publish meaningful revisions, review changes, and merge work without needing a command line.

**Current stage:** a working Next.js/TypeScript/Tailwind editor with Firebase sign-in, plus an implemented backend foundation for private projects, cloud drafts, real Git commits, branches, and invitations. The dashboard and project editor are connected to the backend APIs, including private membership gates and cloud autosave. Anonymous trials remain browser-local. Firebase backend deployment is still required for production cloud flows. Merges are still planned.

See [Backend implementation and collaboration walkthrough](docs/backend.md) for APIs, schemas, authorization, emulator tests, deployment, and the two-writer workflow.

## Contents

- [Product direction](#product-direction)
- [What works today](#what-works-today)
- [Development setup](#development-setup)
- [Using the editor](#using-the-editor)
- [Formatting and styling](#formatting-and-styling)
- [Code architecture](#code-architecture)
- [Draft storage and recovery](#draft-storage-and-recovery)
- [Validation](#validation)
- [Builds and deployment](#builds-and-deployment)
- [Known limitations](#known-limitations)
- [Planned product and backend architecture](#planned-product-and-backend-architecture)
- [Implementation roadmap](#implementation-roadmap)
- [Next development tasks](#next-development-tasks)

## Product direction

DraftBranch is intended to become “GitHub for screenplays”: private projects, invited collaborators, alternate drafts, revision history, and reviewed merges, presented through a writing-focused interface.

The main product principle is to separate **saving writing** from **publishing a revision**. Automatic saving protects work in progress. Publishing records an intentional change that other project members can review.

The first complete collaborative workflow should be:

1. A writer creates a private project and writes a screenplay.
2. The working draft saves automatically.
3. The writer publishes a revision, such as “First complete draft.”
4. A collaborator accepts an invitation and creates an alternate branch.
5. The collaborator edits scenes and publishes revisions to that branch.
6. They open a merge request explaining the changes.
7. The project owner reviews screenplay-aware differences and comments.
8. They resolve overlapping edits and merge the branch into the main draft.
9. Both writers can compare history and recover earlier material.

“Publish” means making revisions available to authorized project members. It does not mean making the screenplay public.

### Proposed terminology

| Underlying concept | Writer-facing label       |
| ------------------ | ------------------------- |
| Repository         | Project                   |
| Working tree       | Working draft             |
| Branch             | Version / branch          |
| Commit             | Revision                  |
| Push               | Publish revisions         |
| Fetch              | Check for updates         |
| Pull               | Bring in updates          |
| Pull request       | Merge request             |
| Tag                | Milestone                 |
| Revert             | Restore as a new revision |

These are product conventions for future work, not a list of implemented controls.

## What works today

- Editable screenplay title and seven element types: scene heading, action, character, dialogue, parenthetical, shot, and transition.
- Keyboard-driven element switching and insertion.
- Scene outline with navigation and page references.
- US Letter pages with 12-point Courier and screenplay-specific indents.
- A rounded, light-gray highlight across the focused element's width, including empty elements.
- Basic pagination that moves whole elements between pages.
- Page and word counts, zoom, automatic page fitting, and focus mode.
- Browser-local autosave and reload recovery for valid drafts.
- Fountain and JSON export.
- Browser printing / Save as PDF.
- Responsive application layout and externalized styles.
- A landing page at `/` with account creation and sign-in through Firebase Authentication (email and password, or Google). "Try the Editor" signs the visitor in as an anonymous guest and opens a blank project (`/editor?new`). The editor is at `/editor` and redirects signed-out visitors to `/`.

Project editors use membership-checked cloud drafts on main. Anonymous trial editors use local storage and show LOCAL. The hosted preview's private audience is a separate Sites hosting feature.

## Development setup

### Requirements

- Node.js **20.9 or newer**; Node 24 is the recommended development baseline.
- npm.
- A modern browser with localStorage, contentEditable, CSS zoom, and modern CSS calculation support.

The app uses Next.js 16, React 19, TypeScript in strict mode, and Tailwind CSS v4. Exact installed versions are recorded in `package-lock.json`.

### Start locally

From the repository root:

```sh
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To choose a different port:

```sh
npm run dev -- --port 3001
```

No secrets are required. Authentication uses the `draftbranch` Firebase project; its public web config is in `src/lib/firebase/client.ts`, and `.firebaserc` / `firebase.json` select the project and its enabled sign-in providers. Registered users land on /dashboard and can open or create private projects with cloud autosave; anonymous trials remain browser-local.

The project also has a Firestore database (`firestore.rules`), a Cloud Storage bucket (`storage.rules`) and Cloud Functions (`functions/`, its own npm package). The `createUserProfile` function writes a `users/{uid}` document when someone creates an email or Google account; anonymous guests get none. To deploy the rules and functions:

```sh
npm --prefix functions install
npx firebase-tools deploy --only firestore,storage,functions
```

Firebase allows sign-in only from authorized domains (`localhost`, `draftbranch.firebaseapp.com`, and `draftbranch.web.app` by default). Add any other host, such as the Sites preview domain, under Authentication → Settings → Authorized domains in the Firebase console.

### Commands

| Command                               | Purpose                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `npm ci`                              | Install the dependency versions in the lockfile                    |
| `npm run dev`                         | Run the Next.js development server                                 |
| `npm run typecheck`                   | Check TypeScript without emitting JavaScript                       |
| `npm test`                            | Run the draft/export tests through `tsx` and Node's test runner    |
| `npm run build`                       | Build the standard Next.js production application                  |
| `npm start`                           | Serve the standard production build                                |
| `npm run format`                      | Format source, tests, root configuration, and README with Prettier |
| `SITES_STATIC_EXPORT=1 npm run build` | Generate the static deployment in `out/`                           |

Read `AGENTS.md` before automated implementation work. This Next.js installation includes version-specific documentation under `node_modules/next/dist/docs/`.

## Using the editor

The editor loads the existing draft for the current browser origin. If no draft exists, it starts with the sample screenplay, **The Last Light**.

Click an element to edit it. Use the toolbar to change its type, or use the keyboard shortcuts below. The scene outline updates as scene headings change.

| Input                           | Behavior                                                                |
| ------------------------------- | ----------------------------------------------------------------------- |
| `Enter`                         | Split the current element at the caret and create the next element type |
| `Shift + Enter`                 | Insert a line break within an element using native editing behavior     |
| `Tab`                           | Cycle forward within the current element's group (see below)            |
| `Shift + Tab`                   | Cycle backward within the current element's group                       |
| `Backspace` in an empty element | Remove it when another element remains                                  |
| `Cmd/Ctrl + S`                  | Attempt an immediate local save                                         |
| `Escape`                        | Exit focus mode; native dialog dismissal also applies                   |

The Enter sequence is defined in `src/lib/editor/types.ts`:

| Current element | Next element  |
| --------------- | ------------- |
| Scene heading   | Action        |
| Action          | Action        |
| Character       | Dialogue      |
| Dialogue        | Action        |
| Parenthetical   | Dialogue      |
| Shot            | Action        |
| Transition      | Scene heading |

`Tab` then cycles within one of two groups, defined by `TAB_CYCLES` in the same file:

- **General lines:** Action → Character → Transition → Scene heading → Action.
- **Dialogue lines:** Dialogue ↔ Parenthetical.

Shot is in neither group: it is set from the toolbar, and `Tab` on a shot returns to Action. Changing an element to a parenthetical, by `Tab` or the toolbar, adds the enclosing parentheses and keeps the caret inside them. Changing a parenthetical to another type removes them. Pressing `Enter` before a parenthetical's closing `)` keeps the `)` on the parenthetical line.

### Exporting

- **Fountain:** portable text with explicit screenplay element markers.
- **JSON:** the current title, ordered blocks, block IDs, and element types.
- **Print / Save as PDF:** uses the browser's print dialog. Choose US Letter, 100% scale, and disable browser headers and footers.

Fountain and JSON **import are not implemented**. A JSON export is a useful backup, but there is not yet a restore-file control in the UI. PDF generation is currently browser-based, not a dedicated rendering service.

## Formatting and styling

The layout follows the [Screenplay.com basic screenplay format reference](https://screenplay.com/pages/basic-screenplay-format).

### Page settings

| Setting                        | Value                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| Paper                          | US Letter, 8.5 × 11 inches                                             |
| Typeface                       | Courier, with Courier New and monospace fallbacks                      |
| Font size                      | 12 pt                                                                  |
| Line height                    | 12 pt, equivalent to six lines per inch                                |
| Left page margin               | 1.5 inches                                                             |
| Top, right, and bottom margins | 1 inch                                                                 |
| Printable text width           | 6 inches                                                               |
| Page numbers                   | Hidden on page one; subsequent pages use a number followed by a period |

The app uses available system fonts rather than bundling a font file. Font availability can affect visual fidelity between machines.

### Element settings

Indents below are relative to the left edge of the printable area, not the physical page edge.

| Element       | Indent / width                   | Spacing before | Case      |
| ------------- | -------------------------------- | -------------- | --------- |
| Scene heading | 0 / 6 inches                     | One blank line | Uppercase |
| Action        | 0 / 6 inches                     | One blank line | Mixed     |
| Character     | 2.3-inch left indent             | One blank line | Uppercase |
| Dialogue      | 1-inch indent / 3.5-inch width   | None           | Mixed     |
| Parenthetical | 1.5-inch indent / 2.5-inch width | None           | Mixed     |
| Shot          | 0 / 6 inches                     | One blank line | Uppercase |
| Transition    | Flush right in printable area    | One blank line | Uppercase |

The first element on a page has no leading blank line. Display zoom changes screen size, not the underlying page measurements.

### Where to edit styles

Visual styles are externalized. Components use semantic class names; shared layout rules use Tailwind `@apply`. There are no visual style objects embedded in JSX.

| File                        | Responsibility                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| `src/styles/globals.css`    | Tailwind and stylesheet imports                                        |
| `src/styles/theme.css`      | Theme colors, fonts, page measurements, indents, active-element tokens |
| `src/styles/editor.css`     | Sidebar, toolbar, dialogs, application layout, responsive interface    |
| `src/styles/screenplay.css` | Screenplay elements, pages, active highlighting, zoom, and print rules |

For example, edit these variables in `theme.css` to change the active-element appearance:

```css
--script-active-background: #e7e7e7;
--script-active-radius: 4px;
```

The highlight paints the focused element's existing box without adding padding or changing text placement. It is removed when printing. Empty focused elements hide their placeholder text.

Zoom uses `data-zoom` on `.editor-shell`; focus mode uses the `.focus` class. If element-spacing rules change, also review the pagination calculations in `engine.ts`, which currently treat dialogue/parenthetical spacing as zero and other element spacing as one line.

## Code architecture

```text
src/
  app/
    layout.tsx                 Root layout, metadata, global CSS
    page.tsx                   Editor entry point
  components/editor/
    screenplay-editor.tsx      Application state and UI orchestration
    editor-canvas.tsx          React bridge to the editing engine
    sidebar.tsx                Workspace and scene navigation
    toolbar.tsx                Element type, zoom, and focus controls
    editor-dialog.tsx          Export and shortcut dialogs
    use-draft.ts               Local loading, save status, autosave
  lib/editor/
    types.ts                   Draft types, labels, Enter transitions
    engine.ts                  Editing, focus, DOM ownership, pagination
    draft.ts                   Validation, word count, exports
    sample.ts                  Initial example screenplay
  styles/
    globals.css
    theme.css
    editor.css
    screenplay.css
tests/
  draft.test.ts                Persistence compatibility and export tests
.openai/
  hosting.json                 Existing private Site identity and output path
```

### React and editing-engine boundaries

React owns the application interface. `ScreenplayEngine`, a plain TypeScript class, owns the editable DOM subtree inside `#pages`.

This separation prevents React from replacing editable text nodes on every keystroke and resetting the caret. `EditorCanvas` creates the engine on mount and destroys it on unmount. It exposes `focus`, `append`, `setType`, and `paginate` through `CanvasHandle`.

`initialBlocks` initializes the engine once. Updating React draft state does **not** replace the editor contents. A future import, document switch, or branch switch therefore needs an explicit engine document-loading operation or a deliberate remount with a new document identity.

### Data flow

```text
User edit
  → ScreenplayEngine updates its editable DOM
  → onChange emits ordered ScriptBlock records
  → ScreenplayEditor updates the draft
  → useDraft schedules a local save after 250 ms

User edit
  → engine schedules pagination after 400 ms
  → onLayout reports page count and scene locations
  → React updates the outline and status bar
```

The engine reads page dimensions from computed CSS, groups whole blocks into pages, and reuses existing nodes where possible. It restores the selection after pagination moves nodes.

### Current document model

```ts
type ElementType =
  | "scene"
  | "action"
  | "character"
  | "dialogue"
  | "parenthetical"
  | "shot"
  | "transition";

interface ScriptBlock {
  id: string;
  type: ElementType;
  text: string;
}

interface Draft {
  title: string;
  blocks: ScriptBlock[];
}
```

Block IDs survive saving and loading. Array order determines document order. Scene headings are currently blocks in this flat array; scenes are not yet separate canonical records. The `Scene` type used by the outline is derived navigation metadata.

When adding an element type, update the labels, Enter transitions, Fountain serialization, CSS, and relevant tests together.

## Draft storage and recovery

Drafts use the localStorage key:

```text
draftbranch.editor.v1
```

The stored value is `{ title, blocks: [{ id, type, text }] }`. Keep this format compatible with the original prototype until an explicit migration is implemented.

Saving is debounced by 250 ms and also attempted on page hiding, visibility changes, and `Cmd/Ctrl + S`. These lifecycle events are best-effort; a JSON export provides a separate copy.

Storage belongs to a **browser origin**. Localhost, a different localhost port, and the hosted preview have separate drafts. Clearing site data or changing browser profiles can remove access to locally stored writing. There is currently one saved draft per origin, not a project library.

`parseDraft` rejects malformed JSON, missing fields, empty block arrays, unsupported element types, and duplicate block IDs rather than silently discarding content.

### Recovery gaps to address

If loading fails, the app displays a recovery message and initially leaves the stored value untouched. However, editing the replacement sample can subsequently save over that value. A protected recovery flow is a high-priority next task: retain the raw failed payload separately and require an explicit recovery/reset decision before saving a replacement.

Multiple tabs or devices do not have coordination or conflict detection. Two tabs on the same origin can overwrite the same saved draft. Local save status is not a cloud backup or a synchronization guarantee.

## Validation

For application changes:

```sh
npm run typecheck
npm test
npm run build
```

The existing four automated tests cover:

1. Reading legacy drafts while preserving IDs, types, and multiline text.
2. Rejecting malformed content and duplicate block identities.
3. Fountain element markers and character/dialogue/parenthetical adjacency.
4. Word counting for blank and multiline content.

They do not automate browser editing or pagination. Those behaviors have been checked manually during development, but need regression coverage as the editor grows.

Useful browser checks include typing and caret stability, Enter at different positions, multiline paste, element cycling, empty-element deletion, scene navigation, refresh recovery, multi-page reflow, zoom, focus mode, and printed output. Check IME composition, accessibility, and long scripts before expanding the beta audience.

## Builds and deployment

### Standard Next.js server

```sh
npm run build
npm start
```

This is the normal Node-server deployment path.

### Current private preview

[Open the private DraftBranch preview](https://scriptroom-editor-jessen.alpinehibiscus16.chatgpt.site).

The existing Sites project is configured in `.openai/hosting.json`. Its static output directory is `out/`.

```sh
SITES_STATIC_EXPORT=1 npm run build
```

`next.config.ts` enables `output: "export"` only when that flag is set. Build a normal production version again before using `npm start`; the static export is served as files instead.

A build alone does not publish the Site. The Sites workflow synchronizes the source revision, packages the matching export, and deploys a saved version. Keep credentials out of source files and preserve the existing private audience.

Future server endpoints require a Node-capable host, a supported deployment adapter, or a separately hosted API. A browser client can call a separately hosted Firebase/API backend while the frontend remains statically hosted.

## Known limitations

- Guest trial drafts use the legacy browser-local key. Cloud project drafts and recovery are scoped to account/project/branch; migrating a guest draft into a project is not implemented.
- The `/editor` gate is client-side only (the app is statically exported). It is a navigation guard, not access control; the new backend enforces authorization through callable APIs and Firestore/Storage rules independently of that gate.
- No password reset or email verification yet.
- Real Git objects, commits, and branches are implemented in the backend, but there are no project/history UI controls, history comparison, or merging yet.
- No import UI, including JSON restore, Fountain import, or FDX import.
- No multiple-document/project management.
- No character autocomplete, rich-text marks, title-page editor, or dual dialogue.
- Pagination moves whole elements; an element taller than a page can overflow.
- No semantic page-break rules for keeping character cues with dialogue, dialogue continuation markers, or production page locking.
- Native text undo is available, but structural changes do not have complete undo/redo support.
- Plain-text paste currently uses the legacy browser editing API; it needs broader compatibility testing and an eventual replacement strategy.
- No robust corrupt-draft recovery or concurrent-tab protection.
- No dedicated offline application/service-worker support. Editing can continue in an already loaded page, but offline reload is not guaranteed.

## Planned product and backend architecture

This section records the original product direction and remaining roadmap. The current implementation and its deliberate differences are documented in [the backend guide](docs/backend.md).

### Three separate persistence layers

| Layer                   | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| Local working draft     | Immediate recovery and writing during connection loss           |
| Private cloud draft     | Recovery across sessions/devices, without publishing every edit |
| Published Git revisions | Deliberate, attributable, reviewable project history            |

Autosaving should not create a commit per keystroke. Working drafts need a user, document, branch, and base commit, plus version checks for concurrent writes. Preserve unfinished work before switching branches. Never silently replace local changes when a remote branch advances.

### Firebase and Git responsibilities

The backend uses **Firebase plus a Git object service in Cloud Functions**. The table below includes future responsibilities; the backend guide distinguishes what is implemented.

| Component               | Planned responsibility                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Firebase Authentication | Accounts and sign-in                                                                      |
| Firestore               | Projects, memberships, invitations, draft metadata, merge requests, comments, job records |
| Cloud Storage           | Larger draft snapshots, attachments, exports, repository backups                          |
| Application API         | Authorization, validation, synchronization, workflow orchestration                        |
| Git service             | Commits, branch refs, ancestry, diffs, merges, repository integrity                       |
| Background workers      | Imports, PDF generation, notifications, backups                                           |

Keep full snapshots outside single metadata documents when size warrants it. Do not put authoritative Git repositories on an ephemeral container filesystem. The implementation uses temporary workspaces to generate immutable Git objects in Cloud Storage and transactional branch refs in Firestore. A dedicated persistent-disk service remains an option if a full Git remote is needed.

Git objects are authoritative for committed screenplay content and ancestry. Firestore is authoritative for branch refs and application records. Commit summaries can be rebuilt from objects, but refs and permissions require Firestore backups.

The browser can use an application API rather than running a complete Git client. External Git clients and protocol compatibility can wait.

### Canonical screenplay format

Evolve the flat prototype into a versioned structured model:

```text
Project
  Documents
    Screenplay
      Scenes with stable IDs
        Typed blocks with stable IDs
```

Support multiple documents within one project so a television project can hold several episodes. Migrate existing block identities rather than regenerating them.

A candidate Git representation is:

```text
project.json
scripts/
  <script-id>/
    screenplay.json
    scenes/
      <scene-id>.json
```

The screenplay record would hold metadata and scene order. Scene records would contain ordered blocks. Validate this layout in a merge spike before making it a permanent contract.

Serialization must be deterministic: unchanged content should produce unchanged files. Keep cursors, presence, and autosave timestamps outside committed content. Give the schema an explicit version and tested migrations.

Fountain is an interchange format. Avoid treating generated Fountain and structured JSON as two independently editable sources of truth.

### Reliable publication

Publishing or merging should:

1. Authenticate the caller and check current membership/permissions.
2. Validate the document and expected branch head.
3. Perform the Git operation.
4. Advance the ref only if the expected head still matches.
5. Record the result and synchronize application metadata.
6. Handle retries through an idempotency key.

Git and Firestore cannot share one transaction. Explicitly recover from “Git succeeded, metadata update failed.” Disable force pushes and history rewriting initially; restore old work through new revisions.

### Screenplay-aware review and merging

Git provides ancestry and history. The application should provide structural comparison and conflict resolution.

Compare the common ancestor, target branch, and proposed branch. Show scene additions/deletions/moves, dialogue changes, action changes, and formatting changes, with word-level detail where helpful.

| Situation                          | Proposed initial handling            |
| ---------------------------------- | ------------------------------------ |
| Different scenes edited            | Merge automatically                  |
| Distinct blocks edited             | Merge when structurally unambiguous  |
| Same dialogue block edited         | Request a writer's resolution        |
| Scene deleted versus edited        | Explicit conflict                    |
| Conflicting scene order            | Explicit ordering conflict           |
| Concurrent inserts in one location | Ask when intended order is ambiguous |

Keep raw Git conflict markers out of the writing surface. Show original, current, and proposed content, and allow choosing a side or composing a combined result.

Anchor comments to a commit, document, scene, and block. If the anchor is deleted, preserve the comment as outdated rather than attaching it to unrelated writing. Revalidate merges when either branch changes after review. A mechanically clean merge still needs narrative review.

### Private projects and permissions

| Role     | Proposed permissions                               |
| -------- | -------------------------------------------------- |
| Owner    | Manage settings, membership, deletion, and merges  |
| Editor   | Create branches, publish revisions, propose merges |
| Reviewer | Read and comment                                   |

Projects start private. Protect the main branch by default. Invitations should expire, be single-use, and be bound to the intended verified recipient. Grant membership only after acceptance.

Use the same membership boundary for script content, history, comments, attachments, and exports. Enforce authorization in server endpoints as well as database/storage rules. Removing a collaborator prevents future access but cannot retract copies already downloaded.

End-to-end encryption is outside the initial scope. Plan for ordinary authentication, authorization, infrastructure encryption, backups, and avoiding screenplay text in operational logs.

## Implementation roadmap

The original estimate was roughly four to six months for a credible private beta with one experienced full-time developer and occasional design/testing help. The phase ranges below are planning estimates, not delivery commitments. The current UI is an early foundation, not completion of the full editor phase.

### Phase 0 — Validate the hard technical assumptions

**Estimate:** 1–2 weeks.

- Stress-test editing and pagination with full-length screenplays.
- Evaluate whether to retain the custom engine or adopt Tiptap/ProseMirror before building complex editing/history features. The initial plan proposed a structured editor framework; the prototype currently uses a custom engine.
- Prototype deterministic screenplay serialization and scene identities.
- Create a real Git repository, diverge two branches, and resolve an overlapping screenplay edit.

**Exit criterion:** two writers' overlapping changes can be compared and combined into a valid screenplay with preserved Git history.

### Phase 1 — Complete the dependable editor foundation

**Estimate:** 3–5 weeks; partially started.

- Fix corrupt-draft recovery, concurrent-tab handling, and structural undo/redo.
- Add import/restore flows and explicit document loading.
- Add character autocomplete, supported emphasis, and title-page information.
- Improve page splitting, dialogue grouping/continuations, and print fidelity.
- Validate long scripts, clipboard behavior, IME input, and accessibility.
- Test FDX import early if target writers depend on Final Draft.

**Exit criterion:** writers can import, edit, recover, and export a full screenplay without losing supported content.

### Phase 2 — Add private projects and cloud drafts

**Estimate:** 2–3 weeks.

- Introduce accounts, project creation, document lists, roles, invitations, and membership enforcement.
- Configure Firebase Authentication, Firestore, Cloud Storage, and API authorization.
- Synchronize cloud drafts with version checks and truthful local/cloud save indicators.
- Preserve local writing through connection failures and access changes.

**Exit criterion:** an invited collaborator can access the right project, unauthorized users cannot, and conflicting draft writes are never silently overwritten.

### Phase 3 — Add actual version control

**Estimate:** 3–4 weeks.

- Implement the Git service and deterministic canonical files.
- Add branches, named revisions, history, comparison, and restoration.
- Track each working draft's base commit.
- Add expected-head checks, idempotent publishing, and Git/metadata reconciliation.
- Preserve unfinished work through branch changes.

**Exit criterion:** writers can publish and retrieve real Git revisions, while retries and concurrent publishes cannot discard work.

### Phase 4 — Add review and merge workflows

**Estimate:** 3–5 weeks.

- Add merge requests, anchored comments, review state, and protected-main rules.
- Implement conservative structural three-way merges.
- Build visual conflict resolution for text, deletion, and scene ordering.
- Preview the combined screenplay before acceptance.
- Revalidate stale approvals/merge candidates when branch heads change.

**Exit criterion:** a writing pair can complete the branch → edit → review → resolve → merge workflow on a real script.

### Phase 5 — Harden a private beta

**Estimate:** 2–4 weeks.

- Verify import/export fidelity and full-length-script performance.
- Restore repositories and application records from backups in a test environment.
- Add operational monitoring without collecting screenplay content.
- Track save/publish failures, conflict frequency, export time, and cost per active project.
- Test membership revocation, failed jobs, retry behavior, and concurrency.
- Recruit a small group of writing pairs using existing projects.

**Exit criterion:** testers trust the product enough to keep working drafts in it, and recovery procedures have been demonstrated rather than assumed.

### Deferred scope

Simultaneous co-editing, public discovery, external Git clients/GitHub synchronization, native mobile apps, AI writing, advanced production revision features, and end-to-end encryption are not required for the first collaborative release.

## Next development tasks

Recommended order from the current codebase:

1. **Protect recovery:** preserve malformed stored data and prevent replacement autosaves until an explicit choice; add JSON restore.
2. **Build an editor regression harness:** caret, typing, split/delete, IME, paste, reload, pagination, printing, and element-highlight behavior.
3. **Decide the editor foundation:** evaluate a structured editor framework against the custom engine's undo, selection, and pagination needs.
4. **Version the document model:** add document/scene identities and migrate legacy drafts without dropping content.
5. **Complete import/export basics:** Fountain import and round-trip fixtures; investigate limited FDX import with real files.
6. **Prove Git merging in isolation:** implement a small structural merge prototype before connecting cloud permissions and UI workflows.
7. **Connect private cloud projects:** the backend APIs now exist; add project selection, account/project/branch-scoped recovery, cloud saves, commit controls, and invitation acceptance. See the [backend integration sequence](docs/backend.md#next-steps).

Keep the central acceptance test in view: two writers should be able to work independently, understand their differences, and combine their changes without losing writing or having to learn Git commands.

### Final Draft export

Choose **Export → Final Draft (.fdx)** to download the current working draft. The file includes all seven screenplay element types, multiline text, a title page, 12-point Courier, and US Letter layout settings. XML special characters are escaped; characters forbidden by XML 1.0 are replaced with the replacement character. Theme colors do not affect export. Pagination is recalculated by the receiving app. Git history, collaboration metadata, and revision marks are not included. XML validity and serialization are tested; opening in the Final Draft desktop application has not yet been verified. FDX import is not implemented.


### Local Firebase configuration

Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_FIREBASE_API_KEY` to your Firebase web API key. Set the same variable in the hosting build environment before deploying. Local `.env` files are ignored by Git; the example contains no real credentials. The browser key is still public in the compiled frontend: Firebase Authentication, Security Rules, and appropriate API-key restrictions protect the project. Never put service-account credentials or server API secrets in a `NEXT_PUBLIC_` variable.


### Brand and local-data compatibility

The product is DraftBranch; npm package identifiers use lowercase `draftbranch`.
New drafts, project recovery copies, and theme preferences use the `draftbranch.` storage namespace. The compatibility reader in `src/lib/storage.ts` falls back to the previous namespace so existing browser data remains accessible. Existing values are not deleted or overwritten by the rename. The hosted preview URL retains its original hostname until hosting is renamed separately.

## Email access sharing

Owners can invite Readers and Editors by email, manage roles, and revoke access. Invitation links support account-free reading; contributing requires accepting with a verified account matching the invited email. See [sharing setup and permissions](docs/sharing.md) for SMTP configuration, deployment, and security behavior.
