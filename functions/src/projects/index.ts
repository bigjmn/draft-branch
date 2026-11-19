import { defineSecret } from "firebase-functions/params";
import { deliverInvitation, smtpSend } from "./mail";
import { getFirestore } from "firebase-admin/firestore";
import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { CloudObjects } from "./objects";
import { ProjectService } from "./service";
import { id, type Actor } from "./model";

// Lazy construction: Firebase Admin initialization in the entry point runs first.
const service = () => new ProjectService(getFirestore(), new CloudObjects());
function actor(request: CallableRequest): Actor {
  const auth = request.auth;
  if (!auth || auth.token.firebase?.sign_in_provider === "anonymous")
    throw new HttpsError(
      "unauthenticated",
      "Sign in with a permanent account to use cloud projects.",
    );
  return {
    uid: id(auth.uid, "user id"),
    name: String(auth.token.name || "Writer"),
    email: typeof auth.token.email === "string" ? auth.token.email : null,
    emailVerified: auth.token.email_verified === true,
  };
}
const options = {
  region: "us-central1",
  timeoutSeconds: 120,
  memory: "512MiB" as const,
  maxInstances: 10,
};
const callable = (
  fn: (s: ProjectService, a: Actor, data: unknown) => Promise<unknown>,
) => onCall(options, (request) => fn(service(), actor(request), request.data));
export const createProject = callable((s, a, d) => s.createProject(a, d));
export const beginDraftUpload = callable((s, a, d) => s.beginDraftUpload(a, d));
export const commitDraft = callable((s, a, d) => s.commitDraft(a, d));
export const createBranch = callable((s, a, d) => s.createBranch(a, d));
export const inviteProjectMember = callable((s, a, d) => s.inviteMember(a, d));
export const acceptProjectInvitation = callable((s, a, d) =>
  s.acceptInvitation(a, d),
);
export const removeProjectMember = callable((s, a, d) => s.removeMember(a, d));
export const revokeProjectInvitation = callable((s, a, d) =>
  s.revokeInvitation(a, d),
);
export const loadProjectDraft = callable((s, a, d) => s.loadDraft(a, d));
export const readProjectRevision = callable((s, a, d) => s.readRevision(a, d));

export const processProjectCommit = onDocumentCreated(
  {
    ...options,
    document: "projects/{projectId}/operations/{operationId}",
    retry: true,
  },
  (event) =>
    service().processCommit(event.params.projectId, event.params.operationId),
);
export const finalizeProjectDraft = onObjectFinalized(
  {
    ...options,
    bucket:
      process.env.PROJECT_STORAGE_BUCKET ||
      `${process.env.GCLOUD_PROJECT || "draftbranch"}.firebasestorage.app`,
    retry: true,
  },
  (event) =>
    service().finalizeUpload(
      event.data.name,
      String(event.data.generation),
      Number(event.data.size),
      event.data.contentType,
    ),
);

export const getProjectInvitation = onCall(options, (request) =>
  service().sharedInvitation(request.data),
);
export const readSharedProject = onCall(options, (request) =>
  service().sharedInvitation(request.data, true),
);
export const updateProjectMemberRole = callable((s, a, d) =>
  s.updateMemberRole(a, d),
);
const invitationSmtp = defineSecret("INVITATION_SMTP_URL");
export const sendProjectInvitation = onDocumentCreated(
  {
    ...options,
    document: "invitationMail/{mailId}",
    retry: true,
    secrets: [invitationSmtp],
  },
  async (event) => {
    const db = getFirestore();
    await deliverInvitation(db, event.params.mailId, async (message) => {
      if (process.env.FUNCTIONS_EMULATOR === "true") {
        // Local-only inbox: never send real mail from emulator tests.
        await db.doc(`emulatorMail/${event.params.mailId}`).set(message);
      } else {
        await smtpSend(
          invitationSmtp.value(),
          process.env.INVITATION_FROM || "",
          message,
        );
      }
    });
  },
);
