# Editing legal pages

- Edit `terms.md` for `/terms` and `privacy.md` for `/privacy`.
- Use Markdown headings, paragraphs, bold text, links, and lists. No React changes are needed.
- The pages are generated at build time. Rebuild/redeploy after changing the files.
- `src/styles/legal.css` controls page and agreement-checkbox styling.
- The terms preserve the draft from the project discussion, titled Terms of Use to match the UI. Replace all bracketed placeholders before publication and review the proposed 18+ requirement, liability cap, and notice period.
- The privacy policy is intentionally Lorem Ipsum and must be replaced before production use.
- The unchecked agreement box gates email authentication and Google continuation (Google sign-in can also create accounts). Links open in a new tab to preserve form entries. Guest trials are unchanged.
- This is a client-side agreement gate, not an auditable consent registry: no accepted-version/timestamp is persisted or enforced by backend rules yet.
