import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";

initializeApp();

// gRPC status for "document already exists".
const ALREADY_EXISTS = 6;

/**
 * Creates `users/{uid}` when someone signs up with email/password or Google.
 *
 * Uses the 1st-gen Auth trigger: the 2nd-gen equivalent (`beforeUserCreated`)
 * is a blocking function that needs Identity Platform.
 *
 * Anonymous guests ("Try the Editor") have no providers and are skipped.
 * Linking a guest to an account later keeps the same uid and does not fire this
 * trigger, so that flow will need to create the profile itself.
 */
export const createUserProfile = functions.auth
  .user()
  .onCreate(async (user) => {
    if (user.providerData.length === 0) return;
    try {
      await getFirestore()
        .collection("users")
        .doc(user.uid)
        .create({
          email: user.email ?? null,
          displayName: user.displayName ?? null,
          photoURL: user.photoURL ?? null,
          providers: user.providerData.map((p) => p.providerId),
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (error) {
      // A retried event finds the profile already written; leave it alone.
      if ((error as { code?: number }).code !== ALREADY_EXISTS) throw error;
    }
  });

export {
  getProjectInvitation,
  readSharedProject,
  updateProjectMemberRole,
  sendProjectInvitation,
  createProject,
  beginDraftUpload,
  commitDraft,
  createBranch,
  inviteProjectMember,
  acceptProjectInvitation,
  removeProjectMember,
  revokeProjectInvitation,
  loadProjectDraft,
  readProjectRevision,
  processProjectCommit,
  finalizeProjectDraft,
} from "./projects";
