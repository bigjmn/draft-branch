# Email sharing

Owners open **Share** in the editor, enter an email address, and select Reader or Editor. An invitation is queued for email delivery; the dialog displays delivery status, memberships, and the latest 50 invitations. Owners can change member roles, remove members, or revoke individual links.

## Permissions and invitation flow

- Reader: read committed drafts. Accepting an invitation adds the project to the account dashboard.
- Editor: read, create branches, save working drafts, and commit to unprotected branches. Only the owner can commit to protected `main`, invite people, or manage access.
- A recipient opens `/invite?project=…&invitation=…#token=…`. The page shows the owner's name, project title, granted role, sign-in/create-account options, and **Continue with read-only access**.
- Reading through an invitation requires no account. It exposes only the latest committed `main` snapshot, never private working drafts or other branches. An empty/new project therefore shows its initial committed draft until the owner commits changes.
- Accepting requires a permanent account with the invited email verified. The recipient can send a verification email from the invitation page, then return and accept. Wrong-email accounts cannot accept. Existing membership is preserved rather than silently upgraded by another invitation.
- Links expire after seven days. Anyone holding a link, including someone it was forwarded to, can read until expiration or revocation. This is intentional bearer-link access; normal project URLs remain membership-protected.
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
