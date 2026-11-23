import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One desktop installer the site can offer. */
export type DesktopDownload = {
  /** Where the browser fetches it from. */
  href: string;
  version: string;
  /** For example "121 MB". */
  size: string;
};
export type DesktopDownloads = {
  mac?: DesktopDownload;
  windows?: DesktopDownload;
};

/* The installer names `npm run release` produces in desktop/
 * (desktop/scripts/release-lib.mjs has the same shapes). */
const VERSION = String.raw`(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.]+)?`;
const PATTERNS = {
  mac: new RegExp(`^DraftBranch-(${VERSION})-mac-[0-9a-z_]+\\.dmg$`),
  windows: new RegExp(`^DraftBranch-(${VERSION})-win-[0-9a-z_]+\\.exe$`),
};

/** The installers in public/downloads/, newest version of each. Read on the
 * server: once per build for the deployed site, on each request in `next dev`.
 * A platform with no installer in the folder is left out, and the Downloads
 * page shows it as not available yet. */
export function findDesktopDownloads(
  directory = join(process.cwd(), "public", "downloads"),
): DesktopDownloads {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return {};
  }
  const found: DesktopDownloads = {};
  const newest: Partial<Record<keyof DesktopDownloads, number[]>> = {};
  for (const name of names) {
    for (const platform of ["mac", "windows"] as const) {
      const match = PATTERNS[platform].exec(name);
      if (!match) continue;
      const order = [match[2], match[3], match[4]].map(Number);
      const best = newest[platform];
      if (best && !isNewer(order, best)) continue;
      let bytes = 0;
      try {
        const entry = statSync(join(directory, name));
        if (entry.isFile()) bytes = entry.size;
      } catch {
        /* Unreadable: treat it as absent. */
      }
      if (bytes === 0) continue;
      newest[platform] = order;
      found[platform] = {
        href: `/downloads/${name}`,
        version: match[1],
        size: `${Math.max(1, Math.round(bytes / 1e6))} MB`,
      };
    }
  }
  return found;
}

function isNewer(candidate: number[], current: number[]) {
  for (let part = 0; part < candidate.length; part += 1)
    if (candidate[part] !== current[part])
      return candidate[part] > current[part];
  return false;
}
