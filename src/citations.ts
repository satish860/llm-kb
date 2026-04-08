import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageBBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CitationRecord {
  file: string;
  page: number;              // primary page (first page if multi-page)
  quote: string;
  bbox?: BoundingBox;        // single-page bbox (backward compat)
  pages?: PageBBox[];        // multi-page bboxes when quote spans pages
}

export interface MatchedCitation extends CitationRecord {
  matched: boolean;
  confidence: number;          // 0-1
  boundingBoxes: BoundingBox[];
  mergedRect: BoundingBox | null;
}

export interface ParseResult {
  answer: string;          // response text WITHOUT the CITATIONS block
  citations: CitationRecord[];
}

interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A segment maps a range in the concatenated page text back to a bounding box */
interface TextSegment {
  start: number;   // char offset in concatenated text
  end: number;
  bbox: BoundingBox;
}

interface TextRun {
  text: string;
  segments: TextSegment[];
}

// ── Citation parser ────────────────────────────────────────────────────────

/**
 * Parse a CITATIONS: block from an agent response.
 * Returns the answer text (without the block) and extracted citations.
 */
export function parseCitations(agentResponse: string): ParseResult {
  // Find CITATIONS: line (case-insensitive)
  const citationsIdx = agentResponse.search(/^CITATIONS:\s*$/im);
  if (citationsIdx < 0) {
    return { answer: agentResponse, citations: [] };
  }

  const answer = agentResponse.slice(0, citationsIdx).trimEnd();
  const citationsBlock = agentResponse.slice(citationsIdx);

  const citations: CitationRecord[] = [];

  // Match each citation line — handles two formats:
  // Single page: [N] file: "...", page: N, quote: "...", bbox: {x: N, y: N, width: N, height: N}
  // Multi page:  [N] file: "...", pages: [N, M], quote: "...", bbox: [{page: N, ...}, {page: M, ...}]
  const lineRe = /^\s*(?:-\s*)?(?:\[\d+\]\s*)?file:\s*"([^"]+)"\s*,\s*page(s)?:\s*(\[[^\]]+\]|\d+)\s*,\s*quote:\s*"([^"]+)"(.*)/gm;
  let match;
  while ((match = lineRe.exec(citationsBlock)) !== null) {
    const file = match[1];
    const isMultiPage = match[2] === "s";
    const pageStr = match[3].trim();
    const quote = match[4];
    const rest = match[5] || "";

    const citation: CitationRecord = { file, page: 0, quote };

    if (isMultiPage) {
      // pages: [17, 18]
      const pageNums = pageStr.replace(/[\[\]]/g, "").split(/\s*,\s*/).map(Number).filter(n => !isNaN(n));
      citation.page = pageNums[0] || 0;

      // Parse array bbox: [{page: 17, x: ..., y: ..., width: ..., height: ...}, ...]
      const bboxArrayMatch = rest.match(/bbox:\s*\[([^\]]+)\]/);
      if (bboxArrayMatch) {
        const entries = bboxArrayMatch[1].split(/\}\s*,\s*\{/);
        const pageBBoxes: PageBBox[] = [];
        for (const entry of entries) {
          const clean = entry.replace(/[{}]/g, "");
          const pM = clean.match(/page:\s*(\d+)/);
          const xM = clean.match(/x:\s*([\d.]+)/);
          const yM = clean.match(/y:\s*([\d.]+)/);
          const wM = clean.match(/width:\s*([\d.]+)/);
          const hM = clean.match(/height:\s*([\d.]+)/);
          if (pM && xM && yM && wM && hM) {
            pageBBoxes.push({
              page: parseInt(pM[1]),
              x: parseFloat(xM[1]),
              y: parseFloat(yM[1]),
              width: parseFloat(wM[1]),
              height: parseFloat(hM[1]),
            });
          }
        }
        if (pageBBoxes.length > 0) citation.pages = pageBBoxes;
      }
    } else {
      // page: 3
      citation.page = parseInt(pageStr, 10) || 0;

      // Parse single bbox: {x: N, y: N, width: N, height: N}
      const bboxMatch = rest.match(/bbox:\s*\{([^}]+)\}/);
      if (bboxMatch) {
        const bboxStr = bboxMatch[1];
        const xM = bboxStr.match(/x:\s*([\d.]+)/);
        const yM = bboxStr.match(/y:\s*([\d.]+)/);
        const wM = bboxStr.match(/width:\s*([\d.]+)/);
        const hM = bboxStr.match(/height:\s*([\d.]+)/);
        if (xM && yM && wM && hM) {
          citation.bbox = {
            x: parseFloat(xM[1]),
            y: parseFloat(yM[1]),
            width: parseFloat(wM[1]),
            height: parseFloat(hM[1]),
          };
        }
      }
    }

    citations.push(citation);
  }

  return { answer, citations };
}

// ── Text run builder ────────────────────────────────────────────────────────
// Groups PDF textItems into lines, concatenates into searchable text,
// and keeps position mappings so we can trace a substring match back to bboxes.

const Y_TOLERANCE = 3;       // px — items within this are on the same line
const X_GAP_COLUMN = 15;     // px — gap larger than this = column separator (double space)

export function buildTextRun(textItems: TextItem[]): TextRun {
  if (textItems.length === 0) return { text: "", segments: [] };

  // Filter out empty text items
  const items = textItems.filter((t) => t.text.trim().length > 0);
  if (items.length === 0) return { text: "", segments: [] };

  // Sort by y (top→bottom), then x (left→right)
  const sorted = [...items].sort((a, b) => {
    const dy = a.y - b.y;
    if (Math.abs(dy) > Y_TOLERANCE) return dy;
    return a.x - b.x;
  });

  // Group into lines
  const lines: TextItem[][] = [];
  let currentLine: TextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentY) <= Y_TOLERANCE) {
      currentLine.push(sorted[i]);
    } else {
      lines.push(currentLine);
      currentLine = [sorted[i]];
      currentY = sorted[i].y;
    }
  }
  lines.push(currentLine);

  // Sort items within each line by x
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
  }

  // Concatenate into text with segments
  let text = "";
  const segments: TextSegment[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    for (let ii = 0; ii < line.length; ii++) {
      const item = line[ii];

      // Add space between items on the same line.
      // PDF text items are individual words with sub-pixel gaps (0.1-1px).
      // Any non-negative gap means a word boundary.
      if (ii > 0) {
        const prev = line[ii - 1];
        const gap = item.x - (prev.x + prev.width);
        if (gap > X_GAP_COLUMN) {
          text += "  "; // large gap — likely a column separator
        } else if (gap >= 0) {
          text += " ";
        }
        // gap < 0 means overlapping — no space (e.g. kerned characters)
      }

      const start = text.length;
      text += item.text;
      const end = text.length;

      segments.push({
        start,
        end,
        bbox: { x: item.x, y: item.y, width: item.width, height: item.height },
      });
    }

    // Newline between lines
    if (li < lines.length - 1) {
      text += "\n";
    }
  }

  return { text, segments };
}

// ── Matching ────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Find substring match, return [startIndex, endIndex] or null */
function findSubstring(haystack: string, needle: string): [number, number] | null {
  const idx = haystack.indexOf(needle);
  if (idx >= 0) return [idx, idx + needle.length];
  return null;
}

/** Find normalized match — returns char range in the ORIGINAL haystack */
function findNormalized(haystack: string, needle: string): [number, number] | null {
  const normHay = normalize(haystack);
  const normNeedle = normalize(needle);
  if (!normNeedle) return null;

  const idx = normHay.indexOf(normNeedle);
  if (idx < 0) return null;

  // Map normalized position back to original string position.
  // Walk through the original string, tracking normalized chars consumed.
  let normPos = 0;
  let origStart = -1;
  let origEnd = -1;

  for (let i = 0; i < haystack.length && origEnd < 0; i++) {
    const normChar = normalize(haystack[i]);
    if (normChar.length === 0) continue; // skipped char (punctuation, extra space)

    // Handle space collapsing: a run of whitespace becomes one space in normalized form
    if (/\s/.test(haystack[i])) {
      // Skip consecutive whitespace — only count as one normalized char
      let j = i;
      while (j < haystack.length && /\s/.test(haystack[j])) j++;
      if (normPos === idx) origStart = i;
      normPos++; // one space in normalized
      if (normPos >= idx + normNeedle.length && origEnd < 0) origEnd = j;
      i = j - 1;
      continue;
    }

    if (normPos === idx) origStart = i;
    normPos++;
    if (normPos >= idx + normNeedle.length && origEnd < 0) origEnd = i + 1;
  }

  if (origStart >= 0 && origEnd > origStart) return [origStart, origEnd];
  return null;
}

/** Levenshtein distance */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/** Fuzzy sliding window match. Returns [startIndex, endIndex, confidence] or null */
function findFuzzy(
  haystack: string,
  needle: string,
  maxDistRatio = 0.20
): [number, number, number] | null {
  const normHay = normalize(haystack);
  const normNeedle = normalize(needle);
  if (!normNeedle || normNeedle.length < 5) return null;

  const baseSize = normNeedle.length;
  const maxDist = Math.ceil(baseSize * maxDistRatio);

  let bestDist = maxDist + 1;
  let bestIdx = -1;
  let bestWinSize = baseSize;

  // Try a few window sizes around the needle length to handle
  // insertions/deletions that change the matched region's length.
  const minWin = Math.max(5, baseSize - maxDist);
  const maxWin = baseSize + maxDist;

  for (let winSize = minWin; winSize <= maxWin; winSize++) {
    if (winSize > normHay.length) break;
    for (let i = 0; i <= normHay.length - winSize; i++) {
      const window = normHay.substring(i, i + winSize);
      const dist = levenshtein(window, normNeedle);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
        bestWinSize = winSize;
        if (dist === 0) break;
      }
    }
    if (bestDist === 0) break;
  }

  if (bestIdx < 0 || bestDist > maxDist) return null;

  // Map normalized position back to original — approximate
  // Walk original chars to find the start/end
  let normPos = 0;
  let origStart = 0;
  let origEnd = haystack.length;

  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < haystack.length && /\s/.test(haystack[j])) j++;
      if (normPos === bestIdx) origStart = i;
      normPos++;
      if (normPos >= bestIdx + bestWinSize) { origEnd = j; break; }
      i = j - 1;
      continue;
    }
    if (/[^\w\s]/.test(ch)) continue; // punctuation removed in normalize
    if (normPos === bestIdx) origStart = i;
    normPos++;
    if (normPos >= bestIdx + bestWinSize) { origEnd = i + 1; break; }
  }

  const confidence = 1 - bestDist / baseSize;
  return [origStart, origEnd, confidence];
}

// ── Segment → BoundingBox extraction ────────────────────────────────────────

function getBoxesForRange(
  segments: TextSegment[],
  start: number,
  end: number
): BoundingBox[] {
  const boxes: BoundingBox[] = [];
  for (const seg of segments) {
    // Segment overlaps with our range?
    if (seg.end > start && seg.start < end) {
      boxes.push(seg.bbox);
    }
  }
  return boxes;
}

function mergeBoxes(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return {
    x: Math.round(minX * 100) / 100,
    y: Math.round(minY * 100) / 100,
    width: Math.round((maxX - minX) * 100) / 100,
    height: Math.round((maxY - minY) * 100) / 100,
  };
}

// ── Filename resolution ───────────────────────────────────────────────────

/** Strip extensions, number prefixes, and normalize for comparison */
function normalizeFilename(name: string): string {
  return name
    .replace(/\.(md|json|pdf)$/i, "")
    .replace(/^\d+\.\s*/, "")
    .toLowerCase()
    .trim();
}

/** Resolve a citation filename to its .json path, handling number prefixes and typos */
async function resolveJsonPath(file: string, sourcesDir: string): Promise<string | null> {
  // Exact match (with .md → .json)
  const withExt = file.endsWith(".md") ? file : file + ".md";
  const exact = join(sourcesDir, withExt.replace(/\.md$/, ".json"));
  if (existsSync(exact)) return exact;

  try {
    const files = await readdir(sourcesDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const needle = normalizeFilename(file);

    // Pass 1: exact match after normalizing (strips number prefix, extension, case)
    for (const jf of jsonFiles) {
      if (normalizeFilename(jf) === needle) return join(sourcesDir, jf);
    }

    // Pass 2: substring containment
    for (const jf of jsonFiles) {
      const candidate = normalizeFilename(jf);
      if (candidate.includes(needle) || needle.includes(candidate)) {
        return join(sourcesDir, jf);
      }
    }

    // Pass 3: fuzzy — check if most words match (handles typos like "August" vs "Ahgust")
    const needleWords = needle.split(/\s+/);
    let bestScore = 0;
    let bestFile: string | null = null;
    for (const jf of jsonFiles) {
      const candidateWords = normalizeFilename(jf).split(/\s+/);
      const matches = needleWords.filter((w) => candidateWords.some((c) => c.includes(w) || w.includes(c)));
      const score = matches.length / Math.max(needleWords.length, 1);
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestFile = jf;
      }
    }
    if (bestFile) return join(sourcesDir, bestFile);
  } catch {}

  return null;
}

// ── Main match function ─────────────────────────────────────────────────────

export async function matchCitation(
  citation: CitationRecord,
  sourcesDir: string
): Promise<MatchedCitation> {
  const base: MatchedCitation = {
    ...citation,
    matched: false,
    confidence: 0,
    boundingBoxes: [],
    mergedRect: null,
  };

  // Map .md filename to .json — try exact match first, then fuzzy
  const jsonPath = await resolveJsonPath(citation.file, sourcesDir);
  if (!jsonPath) return base;

  let bboxData: any;
  try {
    bboxData = JSON.parse(await readFile(jsonPath, "utf-8"));
  } catch {
    return base;
  }

  // If no page specified, try all pages
  const pagesToTry: any[] = [];
  if (citation.page && citation.page > 0) {
    const page = bboxData.pages?.find((p: any) => p.page === citation.page);
    if (page) pagesToTry.push(page);
    // Also try adjacent pages (off-by-one errors)
    const prev = bboxData.pages?.find((p: any) => p.page === citation.page - 1);
    const next = bboxData.pages?.find((p: any) => p.page === citation.page + 1);
    if (prev) pagesToTry.push(prev);
    if (next) pagesToTry.push(next);
  } else {
    // No page — search all pages
    pagesToTry.push(...(bboxData.pages ?? []));
  }

  if (pagesToTry.length === 0) return base;

  // Try each page, best match wins
  let bestMatch: MatchedCitation | null = null;

  for (const page of pagesToTry) {
    const textItems: TextItem[] = (page.textItems ?? []).map((t: any) => ({
      text: t.text ?? "",
      x: t.x ?? 0,
      y: t.y ?? 0,
      width: t.width ?? 0,
      height: t.height ?? 0,
    }));

    const run = buildTextRun(textItems);
    if (!run.text) continue;

    // 1. Exact match
    const exact = findSubstring(run.text, citation.quote);
    if (exact) {
      const boxes = getBoxesForRange(run.segments, exact[0], exact[1]);
      const result: MatchedCitation = {
        ...citation,
        page: page.page,
        matched: true,
        confidence: 1.0,
        boundingBoxes: boxes,
        mergedRect: mergeBoxes(boxes),
      };
      return result; // perfect match — done
    }

    // 2. Normalized match
    const norm = findNormalized(run.text, citation.quote);
    if (norm) {
      const boxes = getBoxesForRange(run.segments, norm[0], norm[1]);
      const result: MatchedCitation = {
        ...citation,
        page: page.page,
        matched: true,
        confidence: 0.9,
        boundingBoxes: boxes,
        mergedRect: mergeBoxes(boxes),
      };
      if (!bestMatch || result.confidence > bestMatch.confidence) bestMatch = result;
      continue;
    }

    // 3. Fuzzy match
    const fuzzy = findFuzzy(run.text, citation.quote);
    if (fuzzy) {
      const [start, end, confidence] = fuzzy;
      const boxes = getBoxesForRange(run.segments, start, end);
      const result: MatchedCitation = {
        ...citation,
        page: page.page,
        matched: confidence >= 0.5,
        confidence,
        boundingBoxes: boxes,
        mergedRect: mergeBoxes(boxes),
      };
      if (!bestMatch || result.confidence > bestMatch.confidence) bestMatch = result;
    }
  }

  return bestMatch ?? base;
}
