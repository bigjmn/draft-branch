export function landingState(
  loading: boolean,
  user: { isAnonymous: boolean } | null,
): "loading" | "dashboard" | "landing" {
  if (loading) return "loading";
  return user && !user.isAnonymous ? "dashboard" : "landing";
}
