import { THEME_BOOTSTRAP } from "@/lib/storage";
import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/auth-provider";
import "@/styles/globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
export const metadata: Metadata = {
  title: "DraftBranch — Screenplay editor",
  description: "A quiet writing room for your next screenplay.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_BOOTSTRAP,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
