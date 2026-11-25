# Editing legal pages

- Edit `terms.md` for `/terms` and `privacy.md` for `/privacy`.
- Use Markdown headings, paragraphs, bold text, links, and lists. No React changes are needed.
- The pages are generated at build time. Rebuild/redeploy after changing the files.
- `src/styles/legal.css` controls page and agreement-checkbox styling.
- The terms preserve the draft from the project discussion, titled Terms of Use to match the UI. Replace all bracketed placeholders before publication and review the proposed 18+ requirement, liability cap, and notice period.
- The privacy policy describes what the app collects and which services process it: Firebase/Google Cloud, Google Analytics for Firebase, Resend (invitation email) and Vercel (hosting). Update it whenever a service, AI feature, or payment flow is added or removed.
- The policy already describes Firebase Analytics. When you add it, keep it true: turn off Google signals and ads personalization, set data retention to 14 months, never log script text, comments, names or emails as event parameters, and show a cookie consent banner to EEA/UK visitors before analytics loads.
- The unchecked agreement box gates email authentication and Google continuation (Google sign-in can also create accounts). Links open in a new tab to preserve form entries. Guest trials are unchanged.
- This is a client-side agreement gate, not an auditable consent registry: no accepted-version/timestamp is persisted or enforced by backend rules yet.
- The contact form keeps hashed-IP rate-limit records in Firestore `contactLimits`. The privacy policy says they last about an hour: enable a Firestore TTL policy on the `expiresAt` field of the `contactLimits` collection group so they are deleted automatically.
