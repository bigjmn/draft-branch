import type { Metadata } from "next";
import Link from "next/link";
import { BetaBadge } from "@/components/ui/beta-badge";
import { findDesktopDownloads, type DesktopDownload } from "@/lib/downloads";

export const metadata: Metadata = {
  title: "Downloads — DraftBranch",
  description: "DraftBranch desktop downloads for Mac and Windows.",
};

/** A platform's download button. It is a real link once that platform's
 * installer is in public/downloads/ (see desktop/README.md, "Release"), and
 * the placeholder until then. */
function DownloadAction({
  label,
  noteId,
  installer,
}: {
  label: string;
  noteId: string;
  installer?: DesktopDownload;
}) {
  if (!installer)
    return (
      <>
        <button type="button" disabled aria-describedby={noteId}>
          {label} <span aria-hidden="true">↓</span>
        </button>
        <p id={noteId} className="download-availability">
          Download not available yet
        </p>
      </>
    );
  return (
    <>
      <a
        className="download-button"
        href={installer.href}
        download
        aria-describedby={noteId}
      >
        {label} <span aria-hidden="true">↓</span>
      </a>
      <p id={noteId} className="download-availability">
        Version {installer.version} · {installer.size}
      </p>
    </>
  );
}

export default function DownloadsPage() {
  const installers = findDesktopDownloads();
  return (
    <div className="landing downloads-page">
      <nav className="landing-nav" aria-label="Main">
        <Link className="brand" href="/">
          <span className="brand-icon">d.</span> DraftBranch <BetaBadge />
        </Link>
        <div className="landing-links">
          <Link href="/">Back to DraftBranch ↗</Link>
        </div>
      </nav>
      <main className="downloads-main">
        <div className="downloads-intro">
          <p className="downloads-eyebrow">
            YOUR WRITING ROOM, ON YOUR DESKTOP
          </p>
          <h1>Download DraftBranch.</h1>
          <p>A home for your next draft. Choose your platform below.</p>
        </div>
        <div className="downloads-grid">
          <section
            className="download-card"
            aria-labelledby="download-mac-title"
          >
            <div className="download-platform-icon" aria-hidden="true">
              <svg
                viewBox="0 0 48 48"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="6" y="6" width="36" height="27" rx="3" />
                <path d="M6 27h36M24 33v9M16 42h16" />
              </svg>
            </div>
            <h2 id="download-mac-title">For Mac</h2>
            <p>DraftBranch for macOS.</p>
            <DownloadAction
              label="Download for Mac"
              noteId="mac-availability"
              installer={installers.mac}
            />
          </section>
          <section
            className="download-card"
            aria-labelledby="download-pc-title"
          >
            <div className="download-platform-icon" aria-hidden="true">
              <svg
                viewBox="0 0 48 48"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="6" y="6" width="15" height="15" rx="1" />
                <rect x="27" y="6" width="15" height="15" rx="1" />
                <rect x="6" y="27" width="15" height="15" rx="1" />
                <rect x="27" y="27" width="15" height="15" rx="1" />
              </svg>
            </div>
            <h2 id="download-pc-title">For PC</h2>
            <p>DraftBranch for Windows.</p>
            <DownloadAction
              label="Download for Windows"
              noteId="pc-availability"
              installer={installers.windows}
            />
          </section>
        </div>
        <p className="downloads-browser-link">
          Keep writing in the meantime.{" "}
          <Link href="/editor">Open the browser editor ↗</Link>
        </p>
      </main>
    </div>
  );
}
