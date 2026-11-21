# Private projects and Git backend

## Current implementation

The backend foundation is implemented in `functions/src/projects`, with browser API helpers in `src/lib/projects/client.ts`. It uses the existing Firebase Authentication setup. The dashboard and project editor now call these APIs, including cloud autosave. Anonymous trial drafts remain local. No production deployment has been performed.

Implemented: private project creation, membership and invitations, per-user/per-branch cloud drafts, immutable upload tickets, actual Git commits, branches, revision loading, access revocation, asynchronous operation status, screenplay-aware three-way merges with conflict resolution, two-parent merge commits, and merge requests with owner approval for protected branches. The existing user-profile Auth trigger is preserved.

Not implemented: word-level merging, cherry-pick/revert, branch deletion, Git smart HTTP, project deletion, storage cleanup, quotas, and production monitoring. One project currently contains one screenplay. No end-to-end encryption is used; server administrators can access stored content.

## Architecture

| Component                         | Responsibility                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Firebase Auth                     | Establish identity; cloud operations require a nonanonymous account                                               |
| Callable Functions in us-central1 | Validate input and authorize project operations                                                                   |
| Firestore                         | Membership, invitations, working-draft pointers/versions, authoritative branch heads, commit metadata, job status |
| Cloud Storage                     | Immutable staging uploads, validated draft snapshots, real Git loose objects                                      |
| Git service                       | Use isomorphic-git to create blobs, trees, and commits; verify hashes when reading revisions                      |
| Firestore trigger                 | Process queued commit requests and atomically advance branch heads                                                |
| Storage finalize trigger          | Validate an uploaded snapshot and advance its private working-draft version                                       |

Git objects are real Git objects, not a changelog pretending to be Git. A native `git fsck --strict` test validates them, and `git show` reads the committed screenplay. Each commit has a tree containing `screenplay.json` and its parent commit IDs. Identical content reuses its object ID.

Unlike the earlier persistent-disk proposal, Functions use temporary directories only to build objects. Durable objects live in Storage, and Firestore transactions serve as the ref store. This avoids needing a persistent Git server for the initial workflow. It is not yet a cloneable Git remote. An export/remote adapter would need to materialize objects and refs. Back up **both Firestore and Storage**: branch names/heads and permissions cannot be reconstructed from commit objects alone.

## Data layout

```text
Firestore
  users/{uid}/projects/{projectId}        personal project-list index
  projects/{projectId}                    title, ownerUid, visibility=private
    members/{uid}                        owner | editor | reviewer
    branches/{branchName}                 head SHA, protected flag
    commits/{commitSHA}                   blob/tree/parent SHAs, message, author UID/name, merge info
    mergeRequests/{requestId}             source/target branch, title, notes, author, open|merged|closed
    workingDrafts/{uid}/branches/{name}   snapshotPath, baseCommit, version, hash
    uploads/{uploadId}                    ticket, expiry, expectedVersion, status
    operations/{operationId}              frozen commit request and result
    invitations/{invitationId}            email, role, expiry, status
    requests/{requestIdHash}              branch-creation and merge replay records

Cloud Storage
  projects/{projectId}/uploads/{uid}/{uploadId}
  projects/{projectId}/drafts/{uid}/{uploadId}.json
  projects/{projectId}/git/objects/{firstTwoSHACharacters}/{remainingSHA}
```

Snapshot v1 is `{ schemaVersion: 1, title, blocks: [{ id, type, text }] }`. It preserves the existing editor's stable block IDs and seven element types. Scene headings remain blocks in an ordered array. The server canonicalizes JSON before committing it. Uploaded JSON is capped at 2 MiB, with at most 10,000 blocks. A future multi-document/scene-file layout needs a schema migration and merge design.

## Walkthrough: two writers

1. **Alice creates a project.** `createProject` authenticates Alice and creates a real initial Git commit containing a blank screenplay. A Firestore transaction creates the private project, Alice's owner membership, her project-list entry, and protected `main` pointing to that commit. Replaying the same request returns the same project.
2. **Alice writes three scenes.** The future editor integration will retain immediate local recovery and call `loadProjectDraft` to obtain the cloud draft's `version`, `baseCommit`, and current branch `head`. It requests a save with `uploadProjectDraft`, passing the expected version, base commit, and a stable request ID. The helper hashes the exact upload bytes, requests a 30-minute upload ticket, and uploads JSON to the ticket's immutable Storage path.
3. **The upload becomes a cloud save.** `finalizeProjectDraft` checks the event generation, size, JSON MIME, hash, schema, membership, expiry, and expected draft version. It writes a validated immutable snapshot, advances Alice's private working-draft pointer from version N to N+1, and marks the ticket `accepted`. Upload completion alone is not save completion; the UI must watch the ticket. No Git commit is created for ordinary autosaves.
4. **Alice commits “First three scenes.”** After the upload is accepted, she calls `commitDraft` with the accepted draft version and expected `main` head. The callable freezes the snapshot, parent, author, timestamp, and message in a queued operation. `processProjectCommit` creates the Git objects, then rechecks access and compares the current head in a transaction. If it still matches, it writes commit metadata, advances `main`, and marks the operation `succeeded`. The unchanged working draft advances its base commit and increments its version; reload before the next save. If Alice has already autosaved newer work, that newer draft is preserved with its original base and needs explicit reconciliation.
5. **Alice invites Bob as an editor.** `inviteProjectMember` creates a pending invitation scoped to Bob's email, valid for seven days. It returns project and invitation IDs; no email is sent yet. Bob signs in and verifies that same email, then calls `acceptProjectInvitation`. The server checks the invitation and inviter's current owner role, creates Bob's membership and project-list entry, and consumes the invitation. Existing members keep their existing role.
6. **Bob creates `alternate-ending`.** `createBranch` checks his editor membership and the expected source head. It creates an unprotected branch pointing to Alice's current commit. It does not copy the screenplay or its history. `loadProjectDraft` loads the committed screenplay for Bob because he has no private draft on that branch yet.
7. **Bob adds a fourth scene and commits.** His upload advances only his own working draft on `alternate-ending`. The commit worker creates a new commit whose parent is Alice's revision and moves only Bob's branch. Alice can read Bob's committed revision as a project member; his uncommitted draft is private. Editors cannot commit directly to protected `main`.
8. **Bob asks to bring his scene into main.** Editors cannot merge into protected `main`, so Bob calls `openMergeRequest` (one open request per source/target pair). `previewProjectMerge` returns the merge base and the three screenplays so any member can see the result and the conflicts.
9. **Alice approves.** If both of them edited the same element, Alice picks a resolution for each conflict, then calls `mergeProjectBranches` with the expected heads of both branches. The server reruns the same merge with her resolutions, refuses if anything is unresolved or either branch moved, writes a commit whose parents are `[main head, branch head]`, advances `main`, and marks open requests for that pair `merged`, all in one transaction. Retrying with the same request ID returns the same merge commit.

```text
initial ── first three scenes ── merge   ← main
                         └── fourth scene ┘   ← alternate-ending
```

### Merge algorithm

`functions/src/projects/merge.ts` is the single implementation. The browser re-exports it from `src/lib/projects/merge.ts` so both sides report identical conflict IDs. Elements are matched by stable block ID against the best common ancestor (`mergeBase`, computed from commit parents in one Firestore read).

| Situation                                                   | Result                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| One side changed an element (text or type), title, or order | Take that change                                              |
| Both made the same change                                   | Take it once                                                  |
| Both changed one element differently                        | `content` conflict: target, source, keep both, or custom text |
| One deleted an element the other edited                     | `delete` conflict: keep the edit or delete                    |
| Both changed the title                                      | `title` conflict: target, source, or custom text              |
| Both inserted or rearranged material in the same gap        | `order` conflict: whose material comes first (both are kept)  |
| Both moved one element to different places                  | `move` conflict: target's or source's position                |

Order is merged separately from content: anchors are elements neither side moved or deleted (a longest-increasing-subsequence over shared IDs). Between anchors, the side that changed the gap wins. Conflict IDs (`title`, `block:<id>`, `order:<anchor>`, `move:<id>`) do not depend on the chosen resolutions.

A clean working draft (its bytes hash to its base commit's Git blob) follows the branch head in `loadDraft`, so writers without uncommitted changes never see a stale draft after someone else commits or merges. Drafts with uncommitted writing keep their base. The editor's **Bring in updates** flow runs the same merge (base commit, your draft, newest head) in the browser, lets the writer resolve conflicts, and saves the result as a working draft on the new head. Nothing is committed.

## Endpoints and event contracts

Use Firebase's `httpsCallable` client, which supplies the signed-in user's token; no server credentials belong in the browser. `src/lib/projects/client.ts` exposes typed wrappers and Firestore listeners.

| Callable                | Input (in addition to authentication)                                                                                            | Result                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| createProject           | title, requestId                                                                                                                 | projectId, branchId, head                              |
| loadProjectDraft        | projectId, branchId                                                                                                              | draft, version, baseCommit, head                       |
| beginDraftUpload        | projectId, branchId, baseCommit, expectedVersion, contentHash, requestId                                                         | uploadId, path, status                                 |
| commitDraft             | projectId, branchId, expectedHead, draftVersion, message, requestId                                                              | operationId, status                                    |
| createBranch            | projectId, name, sourceBranch, expectedHead, requestId                                                                           | branchId, head                                         |
| readProjectRevision     | projectId, commitId                                                                                                              | draft, commitId, parent                                |
| previewProjectMerge     | projectId, sourceBranch, targetBranch                                                                                            | heads, baseCommit, upToDate, base/target/source drafts |
| mergeProjectBranches    | projectId, sourceBranch, targetBranch, expectedSourceHead, expectedTargetHead, resolutions, message?, mergeRequestId?, requestId | commitId, branchId                                     |
| openMergeRequest        | projectId, sourceBranch, targetBranch, title, description?, requestId                                                            | mergeRequestId, status                                 |
| closeMergeRequest       | projectId, mergeRequestId (author or owner)                                                                                      | closed                                                 |
| inviteProjectMember     | projectId, email, role=editor/reviewer, requestId                                                                                | projectId, invitationId, status                        |
| acceptProjectInvitation | projectId, invitationId                                                                                                          | projectId, role                                        |
| removeProjectMember     | projectId, uid                                                                                                                   | removed                                                |
| revokeProjectInvitation | projectId, invitationId                                                                                                          | revoked                                                |

Branch names start with a lowercase letter and accept lowercase letters, digits, and single interior hyphens, at most 64 characters. `main` is protected on creation; there is currently no protection-toggle or ownership-transfer API. Only the owner commits or merges into a protected branch; owners and editors merge into unprotected branches. Members (including readers) can preview merges and read merge requests.

Storage trigger: `finalizeProjectDraft`, bucket object finalization. Only ticket upload paths are processed; generated draft/Git objects are ignored.

Firestore trigger: `processProjectCommit`, document creation at `projects/{projectId}/operations/{operationId}`. Both triggers enable retries for infrastructure errors.

Upload states: `awaiting_upload → accepted | conflict | rejected`. Commit states: `queued → succeeded | conflict | rejected`. A returned operation ID is not a completed commit. Watch terminal status, and display `error` on failure. Reuse request IDs for retries of the _same_ request; changing content under the same ID is rejected. A new operation needs a new ID. Default-generated IDs in convenience helpers must be retained explicitly when retrying uncertain calls.

## Concurrency and authorization

- Two saves from the same draft version cannot overwrite each other: exactly one pointer update wins, the other ticket conflicts.
- Two commit jobs based on the same head cannot both move that head. The losing operation conflicts; immutable orphan objects may remain for later cleanup.
- Duplicate trigger deliveries do not advance versions twice. Commit jobs freeze author/time/content so retries generate identical Git objects.
- Storage uploads use generation preconditions; existing immutable paths cannot change. The server checks the specific finalized generation and requested content hash.
- Revocation is checked both when a request starts and before its authoritative write. Revoked users cannot finish queued commits or pending saves. Previously downloaded local content cannot be recalled.
- All project Firestore writes are server-only. Members can read project metadata/history; users can read only their own working-draft pointers. Owners manage invitations and membership. Reviewers cannot write drafts or create branches/commits.
- Storage rules permit only ticketed staging creates by current writers. Canonical snapshots and Git objects have no direct client read/write access; membership-checking APIs return content. No download tokens or signed URLs are generated by this service.
- An advanced branch is reported as a conflict. There is no automatic rebase or destructive refresh. The integration must preserve local work and offer an explicit reconcile flow.

## Running and verifying

```sh
npm ci
npm ci --prefix functions
npm run typecheck
npm test
npm run test:backend
npm run test:backend:smoke
npm run build
```

`test:backend` requires a JDK supported by the Firebase emulators and the native `git` executable. On this machine, use `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:backend`. It runs against `demo-draftbranch`, never the production project. Firestore integration tests exercise the service directly with an in-memory object store; separate rules tests exercise Firestore and Storage access. Native Git tests verify stored object compatibility. `test:backend:smoke` additionally runs real authenticated callables, Admin SDK object writes/reads, a client upload, and both event triggers in the local emulators. This flow passes locally. The emulator used the installed Node 24; deployment targets Node 22. Local tests do not prove production IAM or production event delivery; perform the deployed staging smoke flow before release.

For interactive emulator development, build Functions first, then start all services:

```sh
npm --prefix functions run build
npx firebase emulators:start --project demo-draftbranch --only auth,firestore,storage,functions
# In another terminal; restart Next when changing this public build-time flag:
NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true npm run dev
```

This flag selects the demo Firebase project and connects the browser SDK to localhost ports 9099/8080/9199/5001. Production builds must omit it. The dashboard and project editor use these emulated APIs when this flag is enabled.

## Deployment handoff

No deployment is included in this change. The target configured project is `draftbranch`, the default database is `(default)`, and the Storage bucket is `draftbranch.firebasestorage.app`. Functions use Node 22 and us-central1. Bucket selection defaults to `<GCLOUD_PROJECT>.firebasestorage.app` (falling back to draftbranch), with a `PROJECT_STORAGE_BUCKET` override for custom buckets. Configure that override consistently during function discovery/deployment and runtime if used. Confirm the bucket exists in the intended region and the project's billing/API setup supports Functions v2/Storage/Eventarc.

After validating a staging deployment, deploy the backend with the Firebase CLI:

```sh
npm --prefix functions run build
npx firebase deploy --project draftbranch --only firestore,storage,functions
```

The CLI needs an authenticated account with appropriate deployment privileges. Storage rules consult Firestore; accept/configure the cross-service permission setup when Firebase prompts. Runtime identities need Firestore and bucket object access; Eventarc requires its event-delivery permissions. These are infrastructure prerequisites, not bypassed by application rules. The existing Auth profile function remains exported.

Smoke-test a real upload through the callable → Storage finalize → accepted ticket path, then a commit through queued → Firestore trigger → succeeded, with a real signed-in account. Repeat with a second account and revoked membership. Monitor failed/retried events before exposing cloud saves. Static Next hosting can keep calling this separately hosted Firebase backend.

## Next steps

1. Add a project picker/create screen and branch selector; scope local recovery by account/project/branch and require explicit migration of legacy local drafts.
2. Wire debounced saves to upload tickets, show pending/accepted/conflict states, and retain local recovery during offline failures. Serialize saves per draft and refresh versions after commits.
3. Add commit/history controls and explicit remote-update handling. Never discard a stale draft just to move its base commit.
4. Add invitation acceptance and verified-email UX, member management, and optional invitation email delivery.
5. Add word-level merging inside an element, merge-request comments anchored to elements, cherry-pick/revert, and branch deletion.
6. Add quotas/rate controls, monitoring, a stuck-job reconciliation process, tested backups, and cleanup of expired uploads/unreferenced objects. Do not delete Git objects solely by age; preserve every reachable history.
7. Add multi-document projects, exports, and an optional standard Git remote/export adapter.

## Dashboard and editor integration

Registered users now land on `/dashboard`; anonymous trials go directly to `/editor` and keep the legacy local draft. The dashboard subscribes to `users/{uid}/projects`, with owned/shared filters, title search, and a private-project creation dialog. Creation uses a retained request ID for safe retries and opens `/editor?project=<id>`.

Project URLs intentionally use a query parameter so the same protected shell works with static exports. A membership listener gates mounting the editor and removes it on revocation. `loadProjectDraft` separately checks membership on the server; Firestore and Storage rules enforce data access independently of navigation. There is no public-link access. Reviewers receive a read-only placeholder pending the review workspace.

Project editors load their private working draft for the selected branch (`main` by default), save local recovery under an account/project/branch-specific key, and serialize cloud uploads. Cloud status is shown only after the finalize trigger accepts the upload. Conflicts pause cloud saves and preserve recovery; export before reconciling. Legacy guest drafts are never automatically migrated. The Version control dialog now provides commit history, screenplay element diffs, commit publishing, and branch creation/switching. Invitation controls remain future work.

The dashboard and editor share persisted light/dark themes; dark is the default. Palette tokens are in `src/styles/theme.css`, application styling in `src/styles/workspace.css`. Print always uses white pages with black text.

Verified locally with Firebase emulators: account sign-in redirect, private project creation and editor navigation, autosave and reload, owned/shared project listings, editor membership, live revocation and direct-link denial, and both theme palettes. Firebase backend deployment is still required for production cloud flows.

## Version control workspace

Open **Version control** in the editor header. The layout follows GitComet:

- **Sidebar:** the working draft ("Uncommitted changes" with a count), "All branches", local branches (protected ones have a lock), ahead/behind counts relative to `main` (↑/↓), the checked-out `HEAD`, and the 12 newest merge requests.
- **Commit graph:** a table of the 300 newest commits across all branches, with columns for branch labels, coloured graph lanes (merge commits are hollow rings), message, author (coloured initials avatar), date, and short revision ID. The top row is the uncommitted working draft. Selecting a branch scopes the graph to commits reachable from it.
- **Revision details:** select a row to see its author, parents (clickable), and element-level changes against its first parent. For a merge commit, these are what the merge brought into the target.

Lane layout and ordering live in `src/lib/projects/graph.ts`. Members get a live Firestore listener. Guest invitation readers fetch the same commit metadata through `readSharedProject` with `graph: true`, which never includes screenplay text. Author names come from the commit's `authorName`, then the member profile, then "Writer". Commits made before `authorName` existed fall back to member profiles.

Merging is under **⇄ Merge**, or **Merge \<branch\>…** when a branch is selected. It previews the result, lists every conflict as a card showing the scene it belongs to, and offers bulk "use all from" choices. Owners see **Approve & merge** for `main`. Editors see **Open merge request** instead, plus a shortcut to bring `main` into their branch so they can settle conflicts themselves. Merge requests show their notes, author, and status. Their author or the owner can close them. Merging into the checked-out branch reloads the editor.

Commit revision publishes the entire screenplay through `commitDraft` and watches the operation until the worker confirms completion. Branch switching waits for acknowledged cloud saves. New branch starts from the selected (or checked-out) branch's committed head. Styling is in `src/styles/version-control.css`, including the lane palette for both themes.
