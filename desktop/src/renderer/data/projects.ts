/** Which project an id refers to, and a signal for "something in it changed". */
import { firebaseAuth } from "@/lib/firebase/client";
import { authorName } from "../../core/snapshot";
import {
  LOCAL_SCOPE,
  type ProjectApi,
  type ProjectRef,
} from "../../core/types";
import { deviceSettings, projectApi } from "../platform/bridge";

/** Projects made on this device have ids starting with "local_"; everything
 * else is a cloud project id and lives under the signed-in account. */
export const isLocalId = (projectId: string) => projectId.startsWith("local_");

export function refOf(projectId: string): ProjectRef {
  if (isLocalId(projectId)) return { scope: LOCAL_SCOPE, id: projectId };
  const uid = firebaseAuth().currentUser?.uid;
  if (!uid) throw new Error("Sign in to open this project.");
  return { scope: uid, id: projectId };
}
export const keyOf = (ref: ProjectRef) => `${ref.scope}/${ref.id}`;
export const apiOf = (projectId: string): ProjectApi =>
  projectApi(refOf(projectId));

const CHANGED = "draftbranch:project-changed";
/** Tell every open view of this project to re-read it. */
export function emitChanged(ref: ProjectRef) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: keyOf(ref) }));
}
export function onChanged(
  ref: ProjectRef | null,
  listener: () => void,
): () => void {
  const handler = (event: Event) => {
    if (!ref || (event as CustomEvent<string>).detail === keyOf(ref))
      listener();
  };
  window.addEventListener(CHANGED, handler);
  return () => window.removeEventListener(CHANGED, handler);
}

const SAVED = "draftbranch:draft-saved";
/** A working draft reached the disk. Separate from "changed" because it
 * happens constantly while typing and nothing needs to re-read the project. */
export function emitSaved(ref: ProjectRef) {
  window.dispatchEvent(new CustomEvent(SAVED, { detail: keyOf(ref) }));
}
export function onSaved(ref: ProjectRef, listener: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === keyOf(ref)) listener();
  };
  window.addEventListener(SAVED, handler);
  return () => window.removeEventListener(SAVED, handler);
}

/** Load now and again after every change, delivering only the newest result. */
export function watch<T>(
  ref: ProjectRef,
  load: () => Promise<T>,
  next: (value: T) => void,
  error: (error: Error) => void,
): () => void {
  let active = true;
  let generation = 0;
  const run = () => {
    const mine = ++generation;
    load().then(
      (value) => {
        if (active && mine === generation) next(value);
      },
      (problem) => {
        if (active && mine === generation)
          error(
            problem instanceof Error ? problem : new Error(String(problem)),
          );
      },
    );
  };
  run();
  const stop = onChanged(ref, run);
  return () => {
    active = false;
    stop();
  };
}

/** The name written on a new revision. Cloud projects use the account's name
 * the way the backend does; device-only projects use the name set in the app. */
export async function revisionAuthor(ref: ProjectRef): Promise<string> {
  const user = firebaseAuth().currentUser;
  if (ref.scope !== LOCAL_SCOPE) {
    const name = authorName(user?.displayName, "");
    return name && name !== "Writer"
      ? name
      : user?.email?.split("@")[0]?.slice(0, 100) || "Writer";
  }
  const settings = await deviceSettings();
  return authorName(settings.writerName || user?.displayName);
}
