/** Stands in for next/navigation in the shared components. */
import { useMemo } from "react";
import { navigate, useLocation } from "../router";

const router = {
  push: (href: string) => navigate(href),
  replace: (href: string) => navigate(href, { replace: true }),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => window.location.reload(),
  prefetch: () => {},
};
export function useRouter() {
  return router;
}
export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}
export function usePathname(): string {
  return useLocation().pathname;
}
