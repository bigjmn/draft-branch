# Scriptroom

A Next.js App Router application, written in TypeScript and styled with Tailwind CSS v4. The editor keeps the original prototype's design and local saved-draft format.

## Development

Requires Node.js 20.9 or newer (Node 24 recommended).

```sh
npm ci
npm run dev
```

Open http://localhost:3000. For a production Node server:

```sh
npm run build
npm start
```

## Edit the design

Styles are externalized; components use semantic class names rather than long utility strings.

- `src/styles/theme.css`: Tailwind theme, colors, fonts, page size, margins, element indents.
- `src/styles/editor.css`: sidebar, toolbar, dialogs, responsive application layout. Uses Tailwind `@apply` for common layout utilities.
- `src/styles/screenplay.css`: screenplay elements, page layout, zoom, and printing.
- `src/styles/globals.css`: stylesheet entry point and Tailwind imports.

No visual styles are embedded in JSX. Zoom uses data attributes and CSS custom properties.

## Application structure

- `src/app`: Next.js root layout and page.
- `src/components/editor`: React UI components and local draft persistence hook.
- `src/lib/editor/engine.ts`: typed, isolated contentEditable editing engine. React owns the chrome; the engine owns only the editable subtree to preserve the caret.
- `src/lib/editor/types.ts`: document types and element transitions.
- `src/lib/editor/draft.ts`: validation, word counts, Fountain and JSON export.
- `tests/draft.test.ts`: legacy draft compatibility and export tests.

Drafts remain in localStorage under `scriptroom.editor.v1`. Stored drafts are origin-specific: the deployed site retains its existing drafts; localhost uses its own browser storage. Firebase and Git synchronization are not implemented.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Run `npm run format` to format source files.

## Sites hosting

The existing private Site is retained in `.openai/hosting.json`. Sites serves the Next.js static export:

```sh
SITES_STATIC_EXPORT=1 npm run build
```

This produces `out/`. Normal builds continue to support `next start`. If server features are introduced later, use a Node-capable host or an appropriate deployment adapter instead of static export.

## Current editor limits

Pagination moves whole elements between pages. Long paragraphs spanning a page, dialogue continuations, production page locking, and complete structural undo are future work. Basic text undo uses the browser editing history. PDF output uses the browser print dialog at 100% scale, with browser headers disabled.
