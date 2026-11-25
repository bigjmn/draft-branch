import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { claimContactQuota, contactMessage, parseContact } from "./contact";
import { smtpSend } from "./projects/mail";

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
  deleteProject,
  processProjectDeletion,
  renameProject,
  beginDraftUpload,
  commitDraft,
  createBranch,
  inviteProjectMember,
  acceptProjectInvitation,
  removeProjectMember,
  revokeProjectInvitation,
  loadProjectDraft,
  readProjectRevision,
  previewProjectMerge,
  mergeProjectBranches,
  openMergeRequest,
  closeMergeRequest,
  processProjectCommit,
  finalizeProjectDraft,
} from "./projects";

const contactSmtp = defineSecret("INVITATION_SMTP_URL");
/**
 * The landing page's contact form. Open to anyone (no sign-in), so it checks
 * input, ignores bots that fill a hidden field, and rate-limits by hashed IP.
 * Mail goes out through the same SMTP connection as project invitations, with
 * Reply-To set to the visitor so a reply reaches them.
 */
export const sendContactMessage = onCall(
  { region: "us-central1", maxInstances: 5, secrets: [contactSmtp] },
  async (request) => {
    const form = parseContact(request.data);
    if (!form) return { status: "sent" };
    const db = getFirestore();
    await claimContactQuota(db, request.rawRequest.ip || "unknown");
    const message = contactMessage(form);
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      await db.collection("emulatorMail").add(message);
      return { status: "sent" };
    }
    try {
      await smtpSend(
        contactSmtp.value(),
        process.env.INVITATION_FROM || "",
        message,
      );
    } catch (error) {
      console.error("Contact message failed", error);
      throw new HttpsError(
        "unavailable",
        "Your message couldn’t be sent right now.",
      );
    }
    return { status: "sent" };
  },
);
