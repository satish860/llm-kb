import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename as pathBasename } from "node:path";

export interface TracePageBBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TraceCitation {
  file: string;
  page: number;
  quote: string;
  bbox?: { x: number; y: number; width: number; height: number };
  pages?: TracePageBBox[];   // multi-page bboxes when quote spans pages
}

export interface KBTrace {
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  mode: "query" | "index" | "unknown";
  question?: string;
  answer?: string;
  answerWithoutCitations?: string;
  citations?: TraceCitation[];
  filesRead: string[];
  filesAvailable: string[];
  filesSkipped: string[];
  model?: string;
  durationMs?: number;
}

/** Parse a session JSONL file and build a KBTrace. Returns null if session isn't complete yet. */
export async function buildTrace(
  sessionFile: string,
  sourcesDir: string
): Promise<KBTrace | null> {
  const raw = await readFile(sessionFile, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return null;

  const entries: any[] = [];
  let header: any = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session") header = obj;
      else entries.push(obj);
    } catch { /* skip malformed lines */ }
  }

  if (!header) return null;

  const messages = entries.filter((e) => e.type === "message");
  const lastAssistant = [...messages].reverse().find(
    (e) => e.message?.role === "assistant" && e.message?.stopReason === "stop"
  );
  if (!lastAssistant) return null;

  const modelChange = entries.find((e) => e.type === "model_change");
  const model = modelChange?.modelId ?? lastAssistant.message?.model ?? undefined;

  const firstUser = messages.find((e) => e.message?.role === "user");
  const question = extractText(firstUser?.message?.content);

  const sessionInfo = entries.find((e) => e.type === "session_info");
  const sessionName: string = sessionInfo?.name ?? "";
  const mode: KBTrace["mode"] = sessionName.startsWith("index:")
    ? "index"
    : sessionName.startsWith("query:") || question
    ? "query"
    : "unknown";

  const answer = extractText(lastAssistant.message?.content);

  const filesRead: string[] = [];
  for (const entry of messages) {
    if (entry.message?.role !== "assistant") continue;
    for (const block of entry.message?.content ?? []) {
      if (block.type === "toolCall" && block.name === "read") {
        const p: string = block.arguments?.path ?? "";
        if (p && !filesRead.includes(p)) filesRead.push(p);
      }
    }
  }

  let filesAvailable: string[] = [];
  try {
    const all = await readdir(sourcesDir);
    filesAvailable = all.filter((f) => f.endsWith(".md"));
  } catch { /* sources dir may not exist */ }

  const filesSkipped = filesAvailable.filter(
    (f) => !filesRead.some((r) => r.endsWith(f))
  );

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  let durationMs: number | undefined;
  if (firstMsg?.timestamp && lastMsg?.timestamp) {
    durationMs = new Date(lastMsg.timestamp).getTime() - new Date(firstMsg.timestamp).getTime();
  }

  return {
    sessionId: header.id,
    sessionFile: pathBasename(sessionFile),
    timestamp: header.timestamp,
    mode,
    question: question || undefined,
    answer: answer || undefined,
    filesRead,
    filesAvailable,
    filesSkipped,
    model,
    durationMs,
  };
}

/** Write a KBTrace to .llm-kb/traces/<sessionId>.json */
export async function saveTrace(kbRoot: string, trace: KBTrace): Promise<void> {
  const tracesDir = join(kbRoot, ".llm-kb", "traces");
  await mkdir(tracesDir, { recursive: true });
  const outPath = join(tracesDir, `${trace.sessionId}.json`);
  await writeFile(outPath, JSON.stringify(trace, null, 2) + "\n", "utf-8");
}

/** Append a query entry to .llm-kb/wiki/queries.md (newest first) */
export async function appendToQueryLog(kbRoot: string, trace: KBTrace): Promise<void> {
  if (trace.mode !== "query" || !trace.question) return;

  const wikiDir = join(kbRoot, ".llm-kb", "wiki");
  await mkdir(wikiDir, { recursive: true });
  const logPath = join(wikiDir, "queries.md");

  const date = new Date(trace.timestamp).toISOString().replace("T", " ").slice(0, 19);
  const durationSec = trace.durationMs ? `${(trace.durationMs / 1000).toFixed(1)}s` : "?";
  const filesLine = trace.filesRead.length > 0
    ? trace.filesRead.map((f) => pathBasename(f)).join(", ")
    : "_none_";

  let header = "";
  if (!existsSync(logPath)) {
    header = `# Query Log\n\nAll queries run against this knowledge base.\n\n---\n\n`;
  }

  const entry = [
    `## ${trace.question}`,
    ``,
    `- **Date:** ${date}`,
    `- **Model:** ${trace.model ?? "unknown"}`,
    `- **Duration:** ${durationSec}`,
    `- **Files read:** ${filesLine}`,
    trace.filesSkipped.length > 0
      ? `- **Files skipped:** ${trace.filesSkipped.join(", ")}`
      : null,
    ``,
    trace.answer ? `### Answer\n\n${trace.answer}` : null,
    ``,
    `---`,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const existing = existsSync(logPath) ? await readFile(logPath, "utf-8") : "";
  await writeFile(logPath, header + entry + existing, "utf-8");
}

// --- helpers ---

function extractText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }
  return "";
}
