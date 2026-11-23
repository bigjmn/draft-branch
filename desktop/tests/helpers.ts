/** Test support: temporary libraries and an in-memory model of the backend. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDrafts } from "../../functions/src/projects/merge";
import { mergeBase, toGraph } from "../src/core/graph";
import {
  type Snapshot,
  authorName,
  blankSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from "../src/core/snapshot";
import {
  type CloudApi,
  type CloudBranch,
  type CloudCommit,
  CloudError,
} from "../src/core/sync/cloud";
import type { CommitResult, Role, SaveResult } from "../src/core/types";
import {
  accountAuthorKey,
  authorEmail,
  encodeCommit,
  encodeTree,
  oidOf,
} from "../src/main/store/git-objects";
import { Library } from "../src/main/store/library";

export async function tempLibrary(t: {
  after: (fn: () => Promise<void>) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), "draftbranch-desktop-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Library(root);
}

export const block = (id: string, text = id, type = "action") => ({
  id,
  type,
  text,
});
export function script(
  title: string,
  ...blocks: ReturnType<typeof block>[]
): Snapshot {
  return parseSnapshot({ title, blocks });
}

interface Actor {
  uid: string;
  name: string;
  email: string;
}
interface FakeProject {
  title: string;
  members: Map<string, Role>;
  branches: Map<string, { head: string; protected: boolean }>;
  commits: Map<string, CloudCommit & { snapshot: Snapshot }>;
  drafts: Map<
    string,
    { snapshot: Snapshot; version: number; baseCommit: string }
  >;
}

/** Behaves like functions/src/projects/service.ts for the calls sync makes:
 * working drafts with versions, commits only on a branch's current head from
 * the saved draft, protected branches, and a draft that follows its branch when
 * it holds no writing of its own. */
export class FakeCloud {
  readonly projects = new Map<string, FakeProject>();
  /** Seconds; advanced by every commit so revision ids are deterministic. */
  clock = 1_800_000_000;
  /** Count of calls by name, for asserting how chatty a sync was. */
  readonly calls: Record<string, number> = {};
  /** Throw "offline" from the named call this many times. */
  readonly failing: Record<string, number> = {};
  /** Omit authorName from commit metadata, like revisions made before it existed. */
  legacyAuthors = false;

  private hit(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.failing[name]) {
      this.failing[name]--;
      throw new CloudError("offline", "You appear to be offline.");
    }
  }
  private project(projectId: string): FakeProject {
    const project = this.projects.get(projectId);
    if (!project) throw new CloudError("not-found", "Project not found.");
    return project;
  }
  private writeCommit(
    project: FakeProject,
    actor: Actor,
    snapshot: Snapshot,
    parent: string[],
    message: string,
    merge?: CloudCommit["merge"],
  ): string {
    const blobBytes = Buffer.from(serializeSnapshot(snapshot));
    const blob = oidOf("blob", blobBytes);
    const tree = oidOf("tree", encodeTree(blob));
    const timestamp = this.clock++;
    const name =
      actor.name && actor.name !== "Writer"
        ? authorName(actor.name)
        : actor.email.split("@")[0] || "Writer";
    const oid = oidOf(
      "commit",
      encodeCommit({
        tree,
        parent,
        author: {
          name,
          email: authorEmail(accountAuthorKey(actor.uid)),
          timestamp,
        },
        message,
      }),
    );
    project.commits.set(oid, {
      oid,
      tree,
      blob,
      parent,
      message,
      actorUid: actor.uid,
      ...(this.legacyAuthors ? {} : { authorName: name }),
      timestamp,
      ...(merge ? { merge } : {}),
      snapshot,
    });
    return oid;
  }

  createProject(
    projectId: string,
    owner: Actor,
    title: string,
    first?: Snapshot,
  ) {
    const project: FakeProject = {
      title,
      members: new Map([[owner.uid, "owner"]]),
      branches: new Map(),
      commits: new Map(),
      drafts: new Map(),
    };
    const head = this.writeCommit(
      project,
      owner,
      first ? parseSnapshot({ ...first, title }) : blankSnapshot(title),
      [],
      "Create project",
    );
    project.branches.set("main", { head, protected: true });
    this.projects.set(projectId, project);
    return project;
  }
  addMember(projectId: string, uid: string, role: Role) {
    this.project(projectId).members.set(uid, role);
  }
  removeMember(projectId: string, uid: string) {
    this.project(projectId).members.delete(uid);
  }
  head(projectId: string, branch: string) {
    return this.project(projectId).branches.get(branch)!.head;
  }
  text(projectId: string, branch: string): Snapshot {
    const project = this.project(projectId);
    return project.commits.get(project.branches.get(branch)!.head)!.snapshot;
  }
  /** First-parent history of a branch, newest first. */
  log(projectId: string, branch: string): string[] {
    const project = this.project(projectId);
    const messages: string[] = [];
    let cursor: string | undefined = project.branches.get(branch)!.head;
    while (cursor) {
      const commit: CloudCommit = project.commits.get(cursor)!;
      messages.push(commit.message);
      cursor = commit.parent[0];
    }
    return messages;
  }
  /** What the web app does: save a working draft, then commit it. */
  webCommit(
    projectId: string,
    actor: Actor,
    branch: string,
    snapshot: Snapshot,
    message: string,
  ) {
    const project = this.project(projectId);
    const ref = project.branches.get(branch)!;
    const oid = this.writeCommit(project, actor, snapshot, [ref.head], message);
    ref.head = oid;
    const key = `${actor.uid}/${branch}`;
    const draft = project.drafts.get(key);
    project.drafts.set(key, {
      snapshot,
      version: (draft?.version ?? 0) + 2,
      baseCommit: oid,
    });
    return oid;
  }
  /** What the web app's autosave does. */
  webDraft(
    projectId: string,
    actor: Actor,
    branch: string,
    snapshot: Snapshot,
  ) {
    const project = this.project(projectId);
    const key = `${actor.uid}/${branch}`;
    const draft = project.drafts.get(key);
    project.drafts.set(key, {
      snapshot,
      version: (draft?.version ?? 0) + 1,
      baseCommit: draft?.baseCommit ?? project.branches.get(branch)!.head,
    });
  }
  webBranch(projectId: string, name: string, source: string) {
    const project = this.project(projectId);
    project.branches.set(name, {
      head: project.branches.get(source)!.head,
      protected: false,
    });
  }
  /** The server-side merge: a two-parent revision on the target. */
  webMerge(projectId: string, actor: Actor, source: string, target: string) {
    const project = this.project(projectId);
    const s = project.branches.get(source)!;
    const t = project.branches.get(target)!;
    const base = mergeBase(toGraph(project.commits.values()), t.head, s.head)!;
    const merged = mergeDrafts(
      project.commits.get(base)!.snapshot,
      project.commits.get(t.head)!.snapshot,
      project.commits.get(s.head)!.snapshot,
    );
    if (merged.unresolved.length) throw new Error("Test merge has conflicts.");
    t.head = this.writeCommit(
      project,
      actor,
      parseSnapshot({ ...merged.draft, schemaVersion: 1 }),
      [t.head, s.head],
      `Merge ${source} into ${target}`,
      { sourceBranch: source, targetBranch: target },
    );
    return t.head;
  }

  as(actor: Actor): CloudApi {
    const role = (projectId: string) =>
      this.projects.get(projectId)?.members.get(actor.uid);
    const member = (projectId: string) => {
      const project = this.project(projectId);
      const mine = role(projectId);
      if (!mine)
        throw new CloudError("denied", "Project access is not permitted.");
      return { project, role: mine };
    };
    const strip = ({
      snapshot: _snapshot,
      ...commit
    }: CloudCommit & { snapshot: Snapshot }) => commit as CloudCommit;
    return {
      uid: actor.uid,
      access: async (projectId) => {
        this.hit("access");
        const project = this.projects.get(projectId);
        const mine = role(projectId);
        return project && mine ? { title: project.title, role: mine } : null;
      },
      branches: async (projectId): Promise<CloudBranch[]> => {
        this.hit("branches");
        return [...member(projectId).project.branches].map(([name, ref]) => ({
          name,
          ...ref,
        }));
      },
      commits: async (projectId) => {
        this.hit("commits");
        return [...member(projectId).project.commits.values()].map(strip);
      },
      commit: async (projectId, oid) => {
        this.hit("commit");
        const commit = member(projectId).project.commits.get(oid);
        return commit ? strip(commit) : null;
      },
      memberNames: async (projectId) => {
        this.hit("memberNames");
        member(projectId);
        return { [actor.uid]: [actor.name] };
      },
      readRevision: async (projectId, oid) => {
        this.hit("readRevision");
        const commit = member(projectId).project.commits.get(oid);
        if (!commit) throw new CloudError("not-found", "Revision not found.");
        return commit.snapshot;
      },
      loadDraft: async (projectId, branch) => {
        this.hit("loadDraft");
        const { project, role: mine } = member(projectId);
        const ref = project.branches.get(branch);
        if (!ref) throw new CloudError("not-found", "Branch not found.");
        const head = ref.head;
        const working = project.drafts.get(`${actor.uid}/${branch}`);
        if (working && mine !== "reviewer") {
          const blob = oidOf(
            "blob",
            Buffer.from(serializeSnapshot(working.snapshot)),
          );
          if (
            working.baseCommit !== head &&
            project.commits.get(working.baseCommit)?.blob === blob
          )
            return {
              draft: project.commits.get(head)!.snapshot,
              version: working.version,
              baseCommit: head,
              head,
            };
          return {
            draft: working.snapshot,
            version: working.version,
            baseCommit: working.baseCommit,
            head,
          };
        }
        return {
          draft: project.commits.get(head)!.snapshot,
          version: 0,
          baseCommit: head,
          head,
        };
      },
      saveDraft: async (input): Promise<SaveResult> => {
        this.hit("saveDraft");
        const { project, role: mine } = member(input.projectId);
        if (mine === "reviewer")
          throw new CloudError("denied", "Project access is not permitted.");
        if (
          !project.branches.has(input.branchId) ||
          !project.commits.has(input.baseCommit)
        )
          throw new CloudError(
            "not-found",
            "Branch or base revision not found.",
          );
        const key = `${actor.uid}/${input.branchId}`;
        if ((project.drafts.get(key)?.version ?? 0) !== input.expectedVersion)
          return {
            status: "conflict",
            error: "The cloud draft changed. Reload before saving.",
          };
        project.drafts.set(key, {
          snapshot: parseSnapshot(input.draft),
          version: input.expectedVersion + 1,
          baseCommit: input.baseCommit,
        });
        return { status: "accepted", version: input.expectedVersion + 1 };
      },
      commitDraft: async (input): Promise<CommitResult> => {
        this.hit("commitDraft");
        const { project, role: mine } = member(input.projectId);
        const ref = project.branches.get(input.branchId);
        if (!ref) throw new CloudError("not-found", "Branch not found.");
        if (mine === "reviewer" || (ref.protected && mine !== "owner"))
          throw new CloudError("denied", "Project access is not permitted.");
        if (ref.head !== input.expectedHead)
          return {
            status: "conflict",
            error: "Branch advanced. Bring in updates before committing.",
          };
        const key = `${actor.uid}/${input.branchId}`;
        const working = project.drafts.get(key);
        if (
          !working ||
          working.version !== input.draftVersion ||
          working.baseCommit !== input.expectedHead
        )
          return {
            status: "rejected",
            error:
              "Save a current cloud draft based on this branch head first.",
          };
        const commitId = this.writeCommit(
          project,
          actor,
          working.snapshot,
          [input.expectedHead],
          input.message,
        );
        ref.head = commitId;
        project.drafts.set(key, {
          ...working,
          baseCommit: commitId,
          version: working.version + 1,
        });
        return { status: "succeeded", commitId };
      },
      createBranch: async (input) => {
        this.hit("createBranch");
        const { project, role: mine } = member(input.projectId);
        if (mine === "reviewer")
          throw new CloudError("denied", "Project access is not permitted.");
        if (project.branches.has(input.name))
          throw new CloudError("other", "Branch already exists.");
        const source = project.branches.get(input.sourceBranch);
        if (!source)
          throw new CloudError("not-found", "Source branch not found.");
        if (source.head !== input.expectedHead)
          throw new CloudError("other", "Source branch advanced.");
        project.branches.set(input.name, {
          head: input.expectedHead,
          protected: false,
        });
      },
      renameProject: async (projectId, title) => {
        this.hit("renameProject");
        const { project, role: mine } = member(projectId);
        if (mine !== "owner")
          throw new CloudError("denied", "Project access is not permitted.");
        project.title = title;
      },
    };
  }
}

export const alice = {
  uid: "alice-uid",
  name: "Alice",
  email: "alice@example.com",
};
export const bob = { uid: "bob-uid", name: "Bob", email: "bob@example.com" };
