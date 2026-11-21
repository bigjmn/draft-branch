import { Suspense } from "react";
import { ProfilePage } from "@/components/profile/profile-page";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import "@/styles/profile.css";
export const metadata = { title: "Writer profile — DraftBranch" };
export default function Page() {
  return (
    <Suspense fallback={<TypewriterLoader />}>
      <ProfilePage />
    </Suspense>
  );
}
