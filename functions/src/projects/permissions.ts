/**
 * Who may edit, branch from, merge into, and comment on which branch.
 *
 * Shared by Cloud Functions (which enforce it), the web editor and the desktop
 * app (which only use it to show the right controls), so all three agree.
 * src/lib/projects/permissions.ts re-exports this file. Keep it free of
 * Firebase imports.
 */
export type Role = "owner" | "editor" | "commenter" | "reviewer";
export const ROLES: Role[] = ["owner", "editor", "commenter", "reviewer"];

/** Options an owner chooses when inviting an editor. */
export interface EditorAccess {
  /** Commit to main and merge into it, as the owner can. */
  editMain: boolean;
  /** Leave comments on main. */
  commentMain: boolean;
  /** A branch made for this editor. If set, they edit only it and branches
   * they create themselves; every other branch is view-only for them. */
  branch: string | null;
}
export const DEFAULT_EDITOR_ACCESS: EditorAccess = {
  editMain: false,
  commentMain: true,
  branch: null,
};

export interface MemberAccess {
  role: Role;
  access?: Partial<EditorAccess> | null;
}
export interface BranchAccessInfo {
  name: string;
  protected: boolean;
  /** Who created the branch (absent on main). */
  createdBy?: string | null;
  /** Set on a dedicated branch: the one editor (besides the owner) who may edit it. */
  dedicatedTo?: string | null;
}

/** An editor's options, with defaults for memberships made before options existed. */
export function editorAccess(member: MemberAccess | null | undefined) {
  const access = member?.access ?? {};
  return {
    editMain: access.editMain === true,
    commentMain: access.commentMain !== false,
    branch:
      typeof access.branch === "string" && access.branch ? access.branch : null,
  } satisfies EditorAccess;
}

export function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

/** May this person save drafts and commit on the branch? */
export function canEditBranch(
  member: MemberAccess | null | undefined,
  uid: string,
  branch: BranchAccessInfo,
): boolean {
  if (!member) return false;
  if (member.role === "owner") return true;
  if (member.role !== "editor") return false;
  // Someone else's dedicated branch belongs to them (and the owner).
  if (branch.dedicatedTo && branch.dedicatedTo !== uid) return false;
  const access = editorAccess(member);
  if (access.branch)
    return (
      !branch.protected &&
      (branch.name === access.branch ||
        branch.dedicatedTo === uid ||
        branch.createdBy === uid)
    );
  return branch.protected ? access.editMain : true;
}

/** May this person create a new branch starting from `source`? */
export function canBranchFrom(
  member: MemberAccess | null | undefined,
  uid: string,
  source: BranchAccessInfo,
): boolean {
  if (!member) return false;
  if (member.role === "owner") return true;
  if (member.role !== "editor") return false;
  // An editor with a dedicated branch makes sub-branches of their own work.
  return editorAccess(member).branch
    ? canEditBranch(member, uid, source)
    : true;
}

/** Merging changes the target branch, so it takes edit access to the target. */
export const canMergeInto = canEditBranch;

/** May this person leave comments on the branch? */
export function canCommentOn(
  member: MemberAccess | null | undefined,
  branch: Pick<BranchAccessInfo, "protected">,
): boolean {
  if (!member) return false;
  if (member.role === "owner" || member.role === "commenter") return true;
  if (member.role !== "editor") return false;
  return branch.protected ? editorAccess(member).commentMain : true;
}

/** The owner resolves and deletes anyone's comments. */
export function canModerateComments(member: MemberAccess | null | undefined) {
  return member?.role === "owner";
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  commenter: "Commenter",
  reviewer: "Reader",
};

/** A short description of an editor's options, e.g. for the member list. */
export function describeAccess(member: MemberAccess): string {
  if (member.role !== "editor") return ROLE_LABELS[member.role];
  const access = editorAccess(member);
  const parts = [
    access.branch
      ? `dedicated branch ${access.branch}`
      : access.editMain
        ? "can edit main"
        : "can’t edit main",
  ];
  if (!access.commentMain) parts.push("no comments on main");
  return `Editor · ${parts.join(" · ")}`;
}
