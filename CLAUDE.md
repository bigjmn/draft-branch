# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

DraftBranch is a browser-local screenplay editor built with Next.js 16 (App Router), React 19, TypeScript (strict), and Tailwind CSS v4. Node 20.9+ is required (Node 24 is recommended). Next.js 16 differs from older versions, so check `node_modules/next/dist/docs/` before using Next APIs.

## Commands

```sh
npm run dev          # dev server at http://localhost:3000
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx, runs tests/*.test.ts
npm run build        # production build (next start serves it)
npm run format       # prettier over src, tests, root configs, README
SITES_STATIC_EXPORT=1 npm run build   # static export to out/ (what the hosted Site serves)
```

To run a single test file: `npx tsx --test tests/draft.test.ts`. To run one test by name, add `--test-name-pattern="Fountain"`.

Validation before finishing a change: `npm run typecheck && npm test && npm run build`.

## Architecture

**React and the editing engine are split on purpose.** `src/lib/editor/engine.ts` (`ScreenplayEngine`) is a plain TypeScript class that owns the contentEditable subtree inside `#pages`: it creates `.page` and `.block` DOM nodes, handles keys (Enter splits the block and gives the new block the type from `NEXT_ELEMENT`; Tab cycles the type within its `TAB_CYCLES` group through `retype`, which adds or removes parenthetical brackets; Backspace on an empty block deletes it), handles paste, and paginates. React never renders the blocks, so it never resets the caret. `EditorCanvas` (`src/components/editor/editor-canvas.tsx`) creates the engine once on mount, sends engine callbacks through a `latest` props ref, and exposes imperative methods (`focus`, `append`, `setType`, `paginate`) through `CanvasHandle`. `ScreenplayEditor` owns the surrounding interface (sidebar, toolbar, dialogs, title, zoom, focus mode) and controls the engine only through that handle. `initialBlocks` is read once; later changes to the draft do not re-render the editor's contents.

**Data flow:** engine `onChange` → `ScreenplayEditor.onBlocks` → `useDraft().update` → localStorage save after a 250 ms debounce. Drafts are also saved on `pagehide`/`visibilitychange`, and Cmd/Ctrl+S saves immediately. The engine re-paginates 400 ms after input and reports `EditorLayout` (page count, plus scenes with page numbers for the sidebar) through `onLayout`.

**Pagination** reads page dimensions from computed CSS (`screenplay.css`/`theme.css`), not from constants in code. It moves whole blocks between pages, puts no gap between dialogue and parenthetical blocks, and restores the selection after moving DOM nodes. Elements that split across pages and dialogue continuations are not implemented yet.

**Persistence and compatibility:**

- Drafts are stored in localStorage under `STORAGE_KEY = "draftbranch.editor.v1"`. Legacy keys are read through `src/lib/storage.ts`. Preserve the stored `{ title, blocks: [{ id, type, text }] }` format. It must stay compatible with drafts saved by the original prototype, and `tests/draft.test.ts` checks that.
- `parseDraft` rejects malformed drafts, empty drafts, unknown element types, and duplicate IDs instead of dropping data. If loading fails, `useDraft` loads the sample draft and shows a recovery banner. Note that the first edit after that still triggers a save that overwrites the unreadable stored draft, because nothing blocks it.
- Element types come from `ELEMENT_LABELS` in `src/lib/editor/types.ts`. Keyboard flow lives in the same file, in `NEXT_ELEMENT` (Enter) and `TAB_CYCLES` (Tab). When adding a type, update those, plus `toFountain` and the CSS for `[data-type=...]`. The README's "Using the editor" tables document the keyboard flow, so keep them in sync.
- Export (`draft.ts`) writes Fountain using forced-element prefixes (`.`, `@`, `>`, `!`) or JSON. PDF output uses the browser print dialog.

**Authentication:** the Firebase project is `draftbranch`, set up through `.firebaserc` and `firebase.json`. The client SDK is initialized lazily in `src/lib/firebase/client.ts`, so call `firebaseAuth()` only in effects or event handlers, never during render or prerender. `AuthProvider` in the root layout exposes `useAuth()`, which returns `{ user, loading }`. `/` is the landing page (`AuthPanel`), and `/editor` wraps the editor in `RequireAuth`. All auth runs in the browser, because the hosted Site is a static export, which can't use cookies, proxy or server actions. Map Firebase error codes to messages in `auth-errors.ts`. "Try the Editor" uses anonymous sign-in and navigates to `/editor?new`; `useDraft` treats `?new` as "start from `createBlankDraft()`" and strips it from the URL (the flag is held in a ref because Strict Mode runs the effect twice). The landing page sends returning account holders straight to `/editor`, but not anonymous guests.

**Firebase backend (Blaze plan):**

- **Firestore:** `(default)` database in `nam5`. Rules in `firestore.rules`: clients can read only `users/{their uid}` and write nothing.
- **Storage:** default bucket `draftbranch.firebasestorage.app` in `us-central1`. Rules in `storage.rules`: each user owns `users/{uid}/**`, with a 20 MB limit per file.
- **Functions:** live in `functions/`, a separate npm package (TypeScript, built to `lib/`, excluded from the root tsconfig).
  - `createUserProfile` is a 1st-gen `auth.user().onCreate` trigger that creates `users/{uid}` (email, displayName, photoURL, providers, createdAt) for new email and Google accounts. Anonymous guests are skipped.
  - It is 1st gen because the 2nd-gen `beforeUserCreated` needs Identity Platform. 1st-gen functions don't support Node 24, so the runtime is `nodejs22`.
- **Deploying:** `npx firebase-tools deploy --only firestore,storage,functions`. The CLI isn't a project dependency.

**Version control and merging:** see `docs/backend.md`. The three-way merge in `functions/src/projects/merge.ts` must stay dependency-free: the browser imports the same file through `src/lib/projects/merge.ts`, and the server reruns it with the client's chosen resolutions, so conflict IDs must stay deterministic. Only the owner commits or merges into protected branches (`assertMergeInto`). The graph layout is pure and tested in `src/lib/projects/graph.ts`.

**Desktop app:** `desktop/` is a separate npm package (Electron and Vite, excluded from the root tsconfig) that builds the shared editor into a desktop app; see `desktop/README.md`. It imports `src/` through the `@/` alias and redirects `@/lib/projects/client` to `desktop/src/renderer/data/client.ts`, which offers the same functions backed by an on-device Git repository. What that means for changes in `src/`:

- Adding or changing an export of `src/lib/projects/client.ts` needs the matching change in the desktop client. `desktop/src/renderer/data/contract.ts` fails the desktop typecheck until it follows.
- Components under `src/components/editor/` take an optional `host` prop (`EditorHost`) and `VersionControlOptions` for desktop-only wording and controls. Keep them optional, with the web behaviour as the default.
- The desktop store writes Git objects byte for byte like `functions/src/projects/git.ts` (blob, one-entry tree, commit and author line), so revisions keep their IDs across the two. `desktop/tests/backend-parity.test.ts` runs the real `GitService` to check it. A change to the object format or to `serializeSnapshot` has to be made on both sides.
- Validate with `cd desktop && npm run typecheck && npm test && npm run build`.

## Styling conventions

- Keep visual styles out of JSX. Components use semantic class names, and the styles live in `src/styles/`: `theme.css` for Tailwind theme tokens, page size, margins and element indents; `editor.css` for the app chrome, using `@apply` for common layout; `screenplay.css` for screenplay elements, pages, zoom and print; `globals.css` as the entry point.
- Zoom and focus mode use data attributes and classes on `.editor-shell` (`data-zoom`, `.focus`) together with CSS custom properties.

## Deployment

`.openai/hosting.json` holds the existing hosted Site configuration. The Site serves the static export, so `next.config.ts` sets `output: "export"` only when `SITES_STATIC_EXPORT=1`. If server-only features are added, they need a Node-capable host.
