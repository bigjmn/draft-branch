import { validateImport } from "./import";
import type { ElementType, ScriptBlock } from "./types";

export interface PdfTextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfPageText {
  width: number;
  height: number;
  runs: PdfTextRun[];
}
interface Line extends PdfTextRun {
  page: number;
}
const scene = /^(?:(?:INT|EXT)\.?\s*(?:\/\s*(?:INT|EXT)\.?)?|I\/E\.?)\s/i;
const continuation = /^(?:\(MORE\)|\(?CONTINUED:?\)?(?:\s*\(\d+\))?)$/i;
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 12;

/** Rebuild reading lines from PDF glyph positions rather than PDF object order. */
export function pdfLines(page: PdfPageText, pageIndex: number): Line[] {
  const rows: PdfTextRun[][] = [];
  for (const run of [...page.runs]
    .filter((r) => r.text.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (
      row &&
      Math.abs(row[0].y - run.y) <=
        Math.max(2, Math.min(row[0].height, run.height) * 0.3)
    )
      row.push(run);
    else rows.push([run]);
  }
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let text = "",
        right = row[0].x;
      for (const run of row) {
        if (
          text &&
          run.x - right > Math.max(1, run.height * 0.15) &&
          !/\s$/.test(text) &&
          !/^\s/.test(run.text)
        )
          text += " ";
        text += run.text;
        right = run.x + run.width;
      }
      return {
        ...row[0],
        text: text.trim(),
        width: right - row[0].x,
        page: pageIndex,
      };
    })
    .filter(
      (line) =>
        line.text &&
        !(
          /^\d+\.?$/.test(line.text) &&
          (line.y < page.height * 0.12 || line.y > page.height * 0.9)
        ) &&
        !continuation.test(line.text),
    );
}

export function parsePdfPages(pages: PdfPageText[], filename: string) {
  const warnings = new Set<string>([
    "PDF formatting is inferred from text positions. Review element types after import; FDX is more precise. Fonts, emphasis, notes, and revision marks are not imported.",
  ]);
  const byPage = pages.map(pdfLines);
  if (!byPage.some((lines) => lines.length))
    throw new Error(
      "This PDF has no readable text. Scanned PDFs need OCR before importing; you can also use an FDX file.",
    );
  if (
    byPage.some(
      (lines, i) =>
        !lines.length && !pages[i].runs.some((run) => run.text.trim()),
    )
  )
    throw new Error(
      "One or more PDF pages contain no readable text. Remove blank pages or run OCR on scanned pages before importing.",
    );
  // Skip a recognizable separate title page, not arbitrary text before the first scene.
  if (
    byPage.length > 1 &&
    !byPage[0].some((l) => scene.test(l.text)) &&
    byPage[0].some((l) => /^(?:written by|screenplay by|by)$/i.test(l.text)) &&
    byPage[1].some((l) => scene.test(l.text))
  ) {
    byPage[0] = [];
    warnings.add(
      "The separate title page was skipped. The filename supplies the project title.",
    );
  }
  // Repeated text at the page edges is usually an export header/footer.
  const repeated = new Map<string, Set<number>>();
  for (const lines of byPage)
    for (const line of lines) {
      if (
        line.y < pages[line.page].height * 0.07 ||
        line.y > pages[line.page].height * 0.94
      ) {
        const seen = repeated.get(line.text) ?? new Set<number>();
        seen.add(line.page);
        repeated.set(line.text, seen);
      }
    }
  const lines = byPage
    .flat()
    .filter(
      (line) =>
        !(
          (repeated.get(line.text)?.size ?? 0) >= 2 &&
          (line.y < pages[line.page].height * 0.07 ||
            line.y > pages[line.page].height * 0.94)
        ),
    );
  const blocks: ScriptBlock[] = [];
  let inDialogue = false;
  let previous: Line | undefined;
  // A dialogue-only page still uses the document's action margin. Normalize
  // by page width so differently sized pages retain comparable indentation.
  const leftRatio = Math.min(
    ...lines.map((line) => line.x / pages[line.page].width),
  );
  const lineHeight = median(lines.map((line) => line.height));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      next = lines[i + 1];
    let text = line.text.replace(/\u00a0/g, " ");
    // Scene numbers sometimes sit in the margins on both sides of a heading.
    const unnumbered = text
      .replace(/^\d+[A-Z]?\s+/, "")
      .replace(/\s+\d+[A-Z]?$/, "");
    const left = leftRatio * pages[line.page].width;
    const indent = line.x - left;
    const samePage = previous?.page === line.page;
    const gap = samePage ? line.y - previous!.y : 0;
    const uppercase = text === text.toUpperCase() && /\p{L}/u.test(text);
    let type: ElementType;
    if (scene.test(unnumbered)) {
      type = "scene";
      text = unnumbered;
      inDialogue = false;
    } else if (
      /^(?:FADE (?:IN|OUT)[.:]|FADE TO BLACK[.:]?|.* TO:)$/i.test(text)
    ) {
      type = "transition";
      inDialogue = false;
    } else if (
      uppercase &&
      text.length <= 65 &&
      !/[.!?:]$/.test(text) &&
      indent > lineHeight * 6 &&
      next &&
      (next.page !== line.page ||
        (next.x < line.x - lineHeight && next.x > left + lineHeight * 2))
    ) {
      type = "character";
      inDialogue = true;
    } else if (inDialogue && text.startsWith("(") && indent > lineHeight * 2)
      type = "parenthetical";
    else if (
      inDialogue &&
      indent > lineHeight * 2 &&
      (!samePage || gap <= lineHeight * 1.8)
    )
      type = "dialogue";
    else {
      type = "action";
      inDialogue = false;
    }
    const last = blocks.at(-1);
    if (
      last?.type === type &&
      ["action", "dialogue", "parenthetical"].includes(type) &&
      (!samePage || gap <= lineHeight * 1.5)
    )
      last.text += " " + text;
    else blocks.push({ id: crypto.randomUUID(), type, text });
    previous = line;
  }
  return {
    draft: validateImport({
      title:
        filename
          .replace(/\.pdf$/i, "")
          .trim()
          .slice(0, 200) || "Untitled screenplay",
      blocks,
    }),
    warnings: [...warnings],
  };
}
