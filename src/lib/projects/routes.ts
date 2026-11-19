export function projectHref(projectId: string) {
  return `/editor?project=${encodeURIComponent(projectId)}`;
}
export function validProjectId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{1,128}$/.test(value));
}
export function projectStorageKey(
  uid: string,
  projectId: string,
  branch = "main",
) {
  return `draftbranch.project.v1.${uid}.${projectId}.${branch}`;
}
