import { readdir } from "node:fs/promises";
import { resolve, extname, relative } from "node:path";

export interface ScannedFile {
  name: string;
  path: string;
  ext: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".xlsx",
  ".xls",
  ".docx",
  ".pptx",
  ".jpg",
  ".jpeg",
  ".png",
  ".txt",
  ".md",
  ".csv",
]);

export async function scan(folder: string): Promise<ScannedFile[]> {
  const root = resolve(folder);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  const files: ScannedFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = resolve(entry.parentPath, entry.name);
    const rel = relative(root, fullPath);

    // Skip .llm-kb internal folder
    if (rel.startsWith(".llm-kb")) continue;

    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    files.push({ name: entry.name, path: rel, ext });
  }

  return files;
}

export function summarize(files: ScannedFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    counts.set(f.ext, (counts.get(f.ext) || 0) + 1);
  }

  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${count} ${ext.toUpperCase().slice(1)}`);

  return parts.join(", ");
}
