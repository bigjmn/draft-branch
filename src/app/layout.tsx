import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/auth-provider";
import "@/styles/globals.css";
export const metadata: Metadata = {
  title: "Scriptroom — Screenplay editor",
  description: "A quiet writing room for your next screenplay.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
