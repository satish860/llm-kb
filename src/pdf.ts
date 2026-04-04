import { LiteParse } from "@llamaindex/liteparse";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

export interface ParsedPDF {
  name: string;
  mdPath: string;
  jsonPath: string;
  totalPages: number;
  textLength: number;
}

export async function parsePDF(
  pdfPath: string,
  outputDir: string
): Promise<ParsedPDF> {
  const name = basename(pdfPath, ".pdf");
  await mkdir(outputDir, { recursive: true });

  const ocrServerUrl = process.env.OCR_SERVER_URL;

  const parser = new LiteParse({
    ocrEnabled: true,
    outputFormat: "json",
    ...(ocrServerUrl ? { ocrServerUrl } : {}),
  });
  const result = await parser.parse(pdfPath, true);

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

  const mdPath = join(outputDir, `${name}.md`);
  const jsonPath = join(outputDir, `${name}.json`);

  await writeFile(mdPath, markdown);
  await writeFile(jsonPath, JSON.stringify(bboxData, null, 2));

  return {
    name,
    mdPath,
    jsonPath,
    totalPages: result.pages.length,
    textLength: markdown.length,
  };
}
