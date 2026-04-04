import { LiteParse } from "@llamaindex/liteparse";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { cpus } from "node:os";

export interface ParsedPDF {
  name: string;
  mdPath: string;
  jsonPath: string;
  totalPages: number;
  textLength: number;
  skipped: boolean;
}

/**
 * Check if source PDF is newer than the parsed output.
 * Returns true if we can skip parsing.
 */
async function isUpToDate(
  pdfPath: string,
  mdPath: string,
  jsonPath: string
): Promise<boolean> {
  try {
    const [pdfStat, mdStat, jsonStat] = await Promise.all([
      stat(pdfPath),
      stat(mdPath),
      stat(jsonPath),
    ]);
    return pdfStat.mtimeMs <= mdStat.mtimeMs && pdfStat.mtimeMs <= jsonStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Suppress stderr temporarily to hide noisy library warnings.
 */
function suppressStderr(): () => void {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as any;
  return () => {
    process.stderr.write = originalWrite;
  };
}

export async function parsePDF(
  pdfPath: string,
  outputDir: string
): Promise<ParsedPDF> {
  const name = basename(pdfPath, ".pdf");
  await mkdir(outputDir, { recursive: true });

  const mdPath = join(outputDir, `${name}.md`);
  const jsonPath = join(outputDir, `${name}.json`);

  // Skip if already parsed and source hasn't changed
  if (await isUpToDate(pdfPath, mdPath, jsonPath)) {
    return { name, mdPath, jsonPath, totalPages: 0, textLength: 0, skipped: true };
  }

  const ocrServerUrl = process.env.OCR_SERVER_URL;
  const ocrEnabled = ocrServerUrl ? true : process.env.OCR_ENABLED === "true";

  const parser = new LiteParse({
    ocrEnabled,
    outputFormat: "json",
    numWorkers: cpus().length,
    ...(ocrServerUrl ? { ocrServerUrl } : {}),
  });

  // Suppress noisy Tesseract/PDF.js warnings during parse
  const restore = suppressStderr();
  let result;
  try {
    result = await parser.parse(pdfPath, true);
  } finally {
    restore();
  }

  // Build markdown — spatial text per page
  const markdown = result.pages
    .map((p: any) => `# Page ${p.pageNum}\n\n${p.text}`)
    .join("\n\n---\n\n");

  // Build bounding box JSON
  const bboxData = {
    source: basename(pdfPath),
    totalPages: result.pages.length,
    pages: result.pages.map((p: any) => ({
      page: p.pageNum,
      width: p.width,
      height: p.height,
      textItems: p.textItems.map((item: any) => ({
        text: (item.str ?? item.text ?? "").trim(),
        x: Math.round(item.x * 100) / 100,
        y: Math.round(item.y * 100) / 100,
        width: Math.round((item.width ?? item.w ?? 0) * 100) / 100,
        height: Math.round((item.height ?? item.h ?? 0) * 100) / 100,
        fontName: item.fontName,
        fontSize: item.fontSize
          ? Math.round(item.fontSize * 100) / 100
          : undefined,
      })),
    })),
  };

  await writeFile(mdPath, markdown);
  await writeFile(jsonPath, JSON.stringify(bboxData, null, 2));

  return {
    name,
    mdPath,
    jsonPath,
    totalPages: result.pages.length,
    textLength: markdown.length,
    skipped: false,
  };
}
