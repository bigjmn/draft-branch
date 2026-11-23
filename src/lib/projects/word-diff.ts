export interface TextSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Words (letters, digits, apostrophes), runs of whitespace, and single
 * punctuation marks, so "Hello." -> "Hello!" changes only the mark. */
const TOKEN = /\s+|[\p{L}\p{N}\p{M}'’]+|[^\s\p{L}\p{N}\p{M}'’]/gu;

/** Above this many token pairs the comparison is skipped (the caller then
 * shows the old and new element whole). Speeches never come close. */
const MAX_CELLS = 4_000_000;

const visible = (text: string) => text.replace(/\s+/g, "").length;

/**
 * Word-level diff of two versions of one element's text, or null when an
 * inline view would not help: the texts are too long to compare, or so little
 * of the shorter version survives that it reads as a rewrite.
 */
export function wordDiff(before: string, after: string): TextSegment[] | null {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];

  // Trim the shared start and end first: typical edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const n = midA.length,
    m = midB.length;
  if (n * m > MAX_CELLS) return null;

  // Longest common subsequence over the middle tokens.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);

  const segments: TextSegment[] = [];
  const push = (kind: TextSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  for (let k = 0; k < start; k++) push("same", a[k]);
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      push("same", midA[i]);
      i++;
      j++;
    } else if (
      j < m &&
      (i === n || lcs[i * width + j + 1] > lcs[(i + 1) * width + j])
    ) {
      push("added", midB[j]);
      j++;
    } else {
      push("removed", midA[i]);
      i++;
    }
  }
  for (let k = endA; k < a.length; k++) push("same", a[k]);

  const kept = segments
    .filter((s) => s.kind === "same")
    .reduce((sum, s) => sum + visible(s.text), 0);
  const shorter = Math.min(visible(before), visible(after));
  if (shorter > 0 && kept / shorter < 0.5) return null;
  return tidy(segments);
}

/** A change that only touches whitespace between two edits reads better as
 * part of them: fold "same" runs that are pure whitespace and sit between
 * changes into the neighbouring removal and addition. */
function tidy(segments: TextSegment[]): TextSegment[] {
  const out: TextSegment[] = [];
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    const prev = segments[k - 1],
      next = segments[k + 1];
    if (
      s.kind === "same" &&
      !s.text.trim() &&
      prev &&
      next &&
      prev.kind !== "same" &&
      next.kind !== "same"
    ) {
      out.push(
        { kind: "removed", text: s.text },
        { kind: "added", text: s.text },
      );
      continue;
    }
    out.push({ ...s });
  }
  // Merge neighbours of one kind, then order each change as removed-then-added.
  const merged: TextSegment[] = [];
  let removed = "",
    added = "";
  const flush = () => {
    if (removed) merged.push({ kind: "removed", text: removed });
    if (added) merged.push({ kind: "added", text: added });
    removed = added = "";
  };
  for (const s of out) {
    if (s.kind === "removed") removed += s.text;
    else if (s.kind === "added") added += s.text;
    else {
      flush();
      const last = merged[merged.length - 1];
      if (last?.kind === "same") last.text += s.text;
      else merged.push(s);
    }
  }
  flush();
  return merged;
}
