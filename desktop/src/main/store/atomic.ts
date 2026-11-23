/** Crash-safe file writes and per-project serialization. */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
export const isMissing = (error: unknown) => codeOf(error) === "ENOENT";

/** Write to a temporary sibling, flush it, then rename over the target, so a
 * crash or power loss leaves either the old file or the new one, never half. */
export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  options: { backup?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.backup)
      await copyFile(path, `${path}.bak`).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    // On Windows a virus scanner or indexer can briefly hold the target open.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (attempt >= 8 || !RETRYABLE.has(codeOf(error))) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Null when the file does not exist. With `backup`, a damaged file falls back
 * to the copy kept by the previous write. */
export async function readJson<T>(
  path: string,
  options: { backup?: boolean } = {},
): Promise<T | null> {
  const parse = async (file: string) =>
    JSON.parse(await readFile(file, "utf8")) as T;
  try {
    return await parse(path);
  } catch (error) {
    if (isMissing(error) && !options.backup) return null;
    if (options.backup) {
      try {
        return await parse(`${path}.bak`);
      } catch (fallback) {
        if (isMissing(error) && isMissing(fallback)) return null;
      }
    }
    if (isMissing(error)) return null;
    throw new Error(`A project file is damaged and could not be read: ${path}`);
  }
}

/** Runs tasks one after another; a failed task does not block the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}
