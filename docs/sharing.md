# Email sharing

Owners open **Share** in the editor (“Share your project”), enter an email address, pick a role (Reader, Commenter or Editor) and can add an optional note, which appears in the email and on the invitation page. Editors get extra options, below. An invitation is queued for email delivery. Under **People and invitations** (collapsed by default) the dialog lists memberships, delivery status and the latest 50 invitations; owners change member roles, remove members, or revoke individual links there.

## Permissions and invitation flow

- Reader: read committed drafts on every branch, and the comments on them. Accepting an invitation adds the project to the account dashboard.
- Commenter: everything a reader can do, plus leave comments on any branch, including main. No editing, branching or committing.
- Editor: read every branch, create branches, save working drafts, commit, and comment, within the options the owner chose:
  - **Allow to edit main branch** (off by default): commit to `main` and merge into it, including approving merge requests, as the owner can. Without it, `main` opens read-only and changes reach it through merge requests.
  - **Create dedicated branch** (off by default), with a branch name: the branch is made from `main` (carrying main's comments) when the editor accepts, and they're taken straight to it. They edit only that branch and branches they create from it; every other branch is read-only for them, and nobody but they and the owner can edit their dedicated branch. Their work reaches `main` through a merge request. A dedicated branch rules out editing main.
  - **Allow comments on main branch** (on by default).
  - Editors invited before these options existed behave as before: they edit every branch except `main` and can comment everywhere.
- Owner: everything, plus inviting people and managing access.
- The rules live in `functions/src/projects/permissions.ts`, shared by Cloud Functions (which enforce them), the web editor and the desktop app. `firestore.rules` mirrors the comment rules.

## Comments

- Comments sit in the left margin of the page, as in WriterDuet. Hovering a line shows a faint chat icon and lightly tints the line; clicking it opens that line's thread, where you can read, add, edit or resolve comments. Lines with open comments keep a solid icon in the theme colour, with a count when there's more than one.
- **Comments** in the editor header lists every comment on the branch in script order (including resolved ones, and comments whose line was deleted) and opens a line's thread.
- People edit, resolve and delete their own comments; the owner can also resolve or delete anyone's.
- A new branch starts with a copy of its parent branch's comments.
- Merge review uses the same comments: hover a line in the merge preview's “Result” diff and click its icon. Review comments are saved on the branch being merged, so they appear beside the same lines in the editor.
- A recipient opens `/invite?project=…&invitation=…#token=…`. The page shows how they were invited (for example “Alice invited you to edit with dedicated branch act-two-pass.”), the owner's note, the project title, sign-in/create-account options, and **Continue with read-only access**. The email uses the same wording.
- Reading through an invitation requires no account. It exposes the committed branches and revision history, never private working drafts. An empty/new project therefore shows its initial committed draft until the owner commits changes.
- Accepting requires a permanent account with the invited email verified. The recipient can send a verification email from the invitation page, then return and accept. Wrong-email accounts cannot accept. Existing membership is preserved rather than silently upgraded by another invitation.
- Links expire after seven days. Anyone holding a link, including someone it was forwarded to, can read until expiration or revocation. This is intentional bearer-link access; normal project URLs remain membership-protected.
- **Require sign-in for read access** (any role, off by default) turns the link off as a reading pass. The invitation page still shows who invited you to what, but `readSharedProject` refuses the draft, the graph and the history. Only the invited email address, signed in, verified and accepted as a member, can read. The email and the invitation page drop the “read without an account” wording, and the owner's invitation list marks these invitations “sign-in required”.
- Revoking a link does not remove an already accepted member. **Remove access** removes membership and revokes that member's accepted invitation links. Previously downloaded/copied content cannot be recalled. Guest views revalidate on focus and every 30 seconds.

## Production configuration

1. Copy `functions/.env.example` to `functions/.env.draftbranch`. Set `PUBLIC_APP_URL` to the deployed frontend HTTPS origin (use the current host until draftbranch.com is connected). Set `INVITATION_FROM` to a sender verified by your email provider.
2. Run `firebase functions:secrets:set INVITATION_SMTP_URL --project draftbranch`. Enter an SMTP URL such as `smtps://USERNAME:PASSWORD@smtp.provider.example:465` or `smtp://USERNAME:PASSWORD@smtp.provider.example:587`. Percent-encode special characters in credentials. TLS is required. Do not commit credentials.
3. Deploy Firestore rules and functions with `firebase deploy --only firestore:rules,functions --project draftbranch`, and deploy the frontend including `/invite`. Configure Firebase Authentication authorized domains for that frontend origin.
4. Send a controlled invitation to your own email, verify delivery and the complete account-verification/acceptance flow before inviting collaborators.

SMTP provider, sender verification, and production deployment are required before real emails can be delivered. SMTP acceptance means the provider accepted the message, not guaranteed inbox delivery.

## Implementation

`inviteProjectMember` atomically creates an invitation and a server-only `invitationMail` job. A random 256-bit token is placed in the URL fragment; only its SHA-256 hash is kept in the owner-readable invitation. The mail job temporarily holds the link so the worker can send it, then removes the link and recipient after delivery or terminal failure. Client rules deny all mail-job and quota access.

`sendProjectInvitation` claims jobs using a transaction lease, retries failures up to five attempts, and exposes only sanitized delivery status. SMTP is at-least-once: a crash after provider acceptance can produce a duplicate message. Stable request IDs prevent duplicate invitation creation on client retries. Each owner is limited to 50 new invitations per hour. To retry a terminally failed invitation, revoke it and send a new invitation.

`getProjectInvitation` and `readSharedProject` validate the token, expiration, revocation, owner membership, and accepted membership if applicable. They deliberately bypass account authentication only for this narrowly scoped read capability. All write, branch, and commit endpoints retain authenticated role checks. Reader maps to the existing backend `reviewer` role.

## Local testing

Run `npm run test:backend` for service and Firebase rules tests. Run `npm run test:backend:smoke` with Java available for real callable and event-delivery tests. In Functions emulation the email worker writes to the server-only `emulatorMail` collection instead of sending real email. Use a local ignored `functions/.secret.local` containing `INVITATION_SMTP_URL=smtp://localhost:1025` if the emulator requests a secret override. The default emulator invitation origin is `http://localhost:3010`; override `PUBLIC_APP_URL` if your preview uses another port.

Relevant files: `functions/src/projects/service.ts`, `functions/src/projects/mail.ts`, `src/components/projects/share-project.tsx`, `src/components/projects/invitation-page.tsx`, and `src/styles/sharing.css`.

## Reader workspace

Readers use the standard editor shell with the title in the header, theme controls, scene navigation, zoom, focus, export, and branch selection. Version control exposes branch history and revision diffs; creating branches and committing are disabled. Guest invitation readers use the same UI through token-validated callable reads, without direct Firestore access. Private uncommitted drafts are excluded. Dashboard navigation prompts signed-out guests to create an account. Sign-in no longer requires repeating the signup agreement checkbox.
