import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import { Suspense } from "react";
import type { Metadata } from "next";
import { InvitationPage } from "@/components/projects/invitation-page";
export const metadata: Metadata = {
  title: "Project invitation — DraftBranch",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return (
    <Suspense fallback={<TypewriterLoader />}>
      <InvitationPage />
    </Suspense>
  );
}
