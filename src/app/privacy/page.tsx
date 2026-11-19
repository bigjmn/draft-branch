import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
export const metadata: Metadata = { title: "Privacy Policy — DraftBranch" };
export default function PrivacyPage() {
  return <LegalPage document="privacy" />;
}
