"use client";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { firebaseDb } from "@/lib/firebase/client";

/** A note anchored to one screenplay element on one branch. Every comment
 * on an element forms its thread. */
export interface ScriptComment {
  id: string;
  authorUid: string;
  authorName: string;
  branch: string;
  blockId: string;
  quote: string;
  text: string;
  resolved: boolean;
  createdAt?: { toMillis: () => number } | null;
  updatedAt?: { toMillis: () => number } | null;
}

/** Live comments on a branch, oldest first. */
export function useBranchComments(
  projectId: string | undefined,
  branch: string | undefined,
) {
  const [state, setState] = useState<{
    key: string;
    comments: ScriptComment[];
    error: boolean;
  }>({ key: "", comments: [], error: false });
  const key = projectId && branch ? `${projectId}:${branch}` : "";
  useEffect(() => {
    if (!projectId || !branch) return;
    const current = `${projectId}:${branch}`;
    return onSnapshot(
      query(
        collection(firebaseDb(), "projects", projectId, "comments"),
        where("branch", "==", branch),
      ),
      (snapshot) =>
        setState({
          key: current,
          error: false,
          comments: snapshot.docs
            .map((d) => ({ ...d.data(), id: d.id }) as ScriptComment)
            .sort((a, b) => time(a) - time(b)),
        }),
      () => setState({ key: current, comments: [], error: true }),
    );
  }, [projectId, branch]);
  const comments = useMemo(
    () => (state.key === key ? state.comments : []),
    [state, key],
  );
  return {
    comments,
    loading: !!key && state.key !== key,
    error: state.key === key && state.error,
  };
}

/** Comments grouped by the element they're on. */
export function byBlock(comments: ScriptComment[]) {
  const map = new Map<string, ScriptComment[]>();
  for (const comment of comments) {
    const list = map.get(comment.blockId) ?? [];
    list.push(comment);
    map.set(comment.blockId, list);
  }
  return map;
}

const time = (c: ScriptComment) =>
  c.createdAt?.toMillis() ?? Number.MAX_SAFE_INTEGER;

const ref = (projectId: string, id: string) =>
  doc(firebaseDb(), "projects", projectId, "comments", id);

/** The name shown on comments: profile name, else the email's first part. */
export function commenterName(user: {
  displayName: string | null;
  email: string | null;
}) {
  return (
    user.displayName?.trim() ||
    user.email?.split("@")[0] ||
    "Writer"
  ).slice(0, 100);
}

export function addComment(input: {
  projectId: string;
  /** Pass the same id when retrying, so a retry never posts twice. */
  id: string;
  authorUid: string;
  authorName: string;
  branch: string;
  blockId: string;
  quote: string;
  text: string;
}) {
  const { projectId, id, ...fields } = input;
  return setDoc(ref(projectId, id), {
    ...fields,
    quote: fields.quote.slice(0, 500),
    text: fields.text.trim(),
    resolved: false,
    createdAt: serverTimestamp(),
  });
}
export const editComment = (projectId: string, id: string, text: string) =>
  updateDoc(ref(projectId, id), {
    text: text.trim(),
    updatedAt: serverTimestamp(),
  });
export const resolveComment = (
  projectId: string,
  id: string,
  resolved: boolean,
) => updateDoc(ref(projectId, id), { resolved });
export const deleteComment = (projectId: string, id: string) =>
  deleteDoc(ref(projectId, id));
