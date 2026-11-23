import { parsePdfPages, type PdfPageText } from "./pdf-layout";

/** Runs only after file selection. Script content never leaves the browser. */
export async function readPdf(file: File) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("Choose a PDF file.");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 20 MiB.");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 300)
      throw new Error("PDF imports are limited to 300 pages.");
    const pages: PdfPageText[] = [];
    let textLength = 0;
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs = content.items.flatMap((item) => {
        if (!("str" in item)) return [];
        textLength += item.str.length;
        const transform = pdfjs.Util.transform(
          viewport.transform,
          item.transform,
        );
        return [
          {
            text: item.str,
            x: transform[4],
            y: transform[5],
            width: item.width,
            height: Math.hypot(transform[2], transform[3]) || item.height || 12,
          },
        ];
      });
      if (textLength > 2 * 1024 * 1024)
        throw new Error("Extracted screenplay exceeds the 2 MiB limit.");
      pages.push({ width: viewport.width, height: viewport.height, runs });
      page.cleanup();
    }
    return parsePdfPages(pages, file.name);
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "This PDF is password-protected. Export an unlocked copy before importing.",
      );
    throw error;
  } finally {
    await task.destroy();
  }
}
