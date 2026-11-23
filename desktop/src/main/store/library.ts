/** Every project kept inside the application's data folder.
 *
 *   <root>/settings.json
 *   <root>/local/<projectId>/            made on this device, no account
 *   <root>/accounts/<uid>/<projectId>/   pulled from DraftBranch cloud
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { toGraph } from "../../core/graph";
import { isProjectId, projectTitle } from "../../core/snapshot";
import { projectStatus } from "../../core/sync/status";
import {
  type DeviceSettings,
  LOCAL_SCOPE,
  type ProjectMeta,
  type ProjectRef,
  type ProjectSummary,
  type Role,
} from "../../core/types";
import { Mutex, readJson, writeFileAtomic } from "./atomic";
import { ProjectStore, StoreError } from "./project-store";

export class Library {
  private readonly stores = new Map<string, Promise<ProjectStore>>();
  private readonly lock = new Mutex();
  private settingsCache: DeviceSettings | null = null;

  constructor(readonly root: string) {}

  // ------------------------------------------------------------ settings

  async settings(): Promise<DeviceSettings> {
    if (this.settingsCache) return this.settingsCache;
    return this.lock.run(async () => {
      if (this.settingsCache) return this.settingsCache;
      const path = join(this.root, "settings.json");
      const saved = await readJson<Partial<DeviceSettings>>(path).catch(
        () => null,
      );
      const settings: DeviceSettings = {
        writerName:
          typeof saved?.writerName === "string"
            ? saved.writerName.slice(0, 100)
            : "",
        writerId:
          typeof saved?.writerId === "string" &&
          /^[a-f0-9]{24}$/.test(saved.writerId)
            ? saved.writerId
            : randomBytes(12).toString("hex"),
      };
      if (settings.writerId !== saved?.writerId)
        await writeFileAtomic(path, JSON.stringify(settings, null, 2) + "\n");
      return (this.settingsCache = settings);
    });
  }
  async updateSettings(patch: Partial<Pick<DeviceSettings, "writerName">>) {
    const current = await this.settings();
    return this.lock.run(async () => {
      const next: DeviceSettings = {
        ...current,
        ...(typeof patch.writerName === "string"
          ? {
              writerName: patch.writerName
                .replace(/[\n\r<>]/g, "")
                .trim()
                .slice(0, 100),
            }
          : {}),
      };
      await writeFileAtomic(
        join(this.root, "settings.json"),
        JSON.stringify(next, null, 2) + "\n",
      );
      return (this.settingsCache = next);
    });
  }

  // ------------------------------------------------------------- folders

  private scopeDir(scope: string): string {
    if (scope === LOCAL_SCOPE) return join(this.root, "local");
    if (!isProjectId(scope))
      throw new StoreError("invalid", "Invalid account.");
    return join(this.root, "accounts", scope);
  }
  private projectDir(ref: ProjectRef): string {
    if (!ref || !isProjectId(ref.id))
      throw new StoreError("invalid", "Invalid project.");
    const dir = resolve(this.scopeDir(ref.scope), ref.id);
    // Ids are restricted to letters, digits, "_" and "-", so this cannot
    // escape the library; the check documents and enforces that.
    if (!dir.startsWith(resolve(this.root) + sep))
      throw new StoreError("invalid", "Invalid project.");
    return dir;
  }

  /** One store per project for the life of the process, so its writes are serialized. */
  async open(ref: ProjectRef): Promise<ProjectStore> {
    const dir = this.projectDir(ref);
    let store = this.stores.get(dir);
    if (!store) {
      store = this.settings().then((s) => ProjectStore.open(dir, s.writerId));
      this.stores.set(dir, store);
      store.catch(() => this.stores.delete(dir));
    }
    return store;
  }

  // ------------------------------------------------------------- listing

  async list(scope: string): Promise<ProjectSummary[]> {
    const folder = this.scopeDir(scope);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const summaries: ProjectSummary[] = [];
    for (const id of names) {
      if (!isProjectId(id)) continue;
      try {
        summaries.push(await this.summary({ scope, id }));
      } catch {
        /* Not a project (an unfinished creation or a stray folder). */
      }
    }
    return summaries.sort(
      (a, b) =>
        (b.meta.openedAt ?? b.meta.updatedAt) -
        (a.meta.openedAt ?? a.meta.updatedAt),
    );
  }
  async summary(ref: ProjectRef): Promise<ProjectSummary> {
    const store = await this.open(ref);
    const state = await store.state();
    const status = state.meta.cloud
      ? projectStatus(state, toGraph(await store.commits()).values())
      : null;
    return {
      ref,
      meta: state.meta,
      branches: state.branches.length,
      unpublished: status
        ? status.unpublishedRevisions + status.unpublishedBranches
        : 0,
      incoming: status?.incoming ?? 0,
      drafts: state.drafts.filter((d) => !d.clean).length,
    };
  }

  // ------------------------------------------------------------ creating

  async createLocal(input: {
    title: unknown;
    draft?: unknown;
    authorName?: unknown;
  }): Promise<ProjectMeta> {
    const title = projectTitle(input.title);
    const settings = await this.settings();
    const ref = {
      scope: LOCAL_SCOPE,
      id: `local_${randomBytes(12).toString("hex")}`,
    };
    const dir = this.projectDir(ref);
    await mkdir(dir, { recursive: true });
    try {
      const store = ProjectStore.create(dir, settings.writerId, {
        id: ref.id,
        title,
        snapshot: input.draft,
        authorName:
          typeof input.authorName === "string"
            ? input.authorName
            : settings.writerName,
      });
      this.stores.set(dir, store);
      return (await (await store).state()).meta;
    } catch (error) {
      this.stores.delete(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** An empty local home for a cloud project; the first sync fills it in. */
  async createClone(input: {
    uid: string;
    projectId: string;
    title: unknown;
    role: Role;
  }): Promise<ProjectMeta> {
    if (!["owner", "editor", "reviewer"].includes(input.role))
      throw new StoreError("invalid", "Invalid role.");
    const ref = { scope: input.uid, id: input.projectId };
    if (input.uid === LOCAL_SCOPE)
      throw new StoreError("invalid", "Invalid account.");
    const dir = this.projectDir(ref);
    try {
      return (await (await this.open(ref)).state()).meta;
    } catch {
      /* Not pulled before. */
    }
    const settings = await this.settings();
    await mkdir(dir, { recursive: true });
    const store = ProjectStore.create(dir, settings.writerId, {
      id: ref.id,
      title: projectTitle(input.title),
      cloud: { uid: input.uid, role: input.role },
    });
    this.stores.set(dir, store);
    store.catch(() => this.stores.delete(dir));
    return (await (await store).state()).meta;
  }

  /** Removes the project from this device only. */
  async remove(ref: ProjectRef): Promise<void> {
    const dir = this.projectDir(ref);
    this.stores.delete(dir);
    // Retries cover Windows briefly holding a file open (indexer, antivirus).
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
