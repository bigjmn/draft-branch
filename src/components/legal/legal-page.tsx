import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import Markdown from "react-markdown";

/** Legal copy lives in content/legal/*.md; never load a user-supplied path. */
export async function LegalPage({
  document,
}: {
  document: "terms" | "privacy";
}) {
  const content = await readFile(
    path.join(process.cwd(), "content", "legal", `${document}.md`),
    "utf8",
  );
  return (
    <main className="legal-page">
      <nav className="legal-nav" aria-label="Legal navigation">
        <Link href="/">← DraftBranch</Link>
        <Link
          href="/terms"
          aria-current={document === "terms" ? "page" : undefined}
        >
          Terms of Use
        </Link>
        <Link
          href="/privacy"
          aria-current={document === "privacy" ? "page" : undefined}
        >
          Privacy Policy
        </Link>
      </nav>
      <article className="legal-content">
        <Markdown>{content}</Markdown>
      </article>
      <footer className="legal-footer">
        DraftBranch · J Nicks Productions
      </footer>
    </main>
  );
}
