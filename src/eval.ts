import { completeSimple } from "@mariozechner/pi-ai";
import { resolveModel, resolveApiKey as resolveApiKeyFromProvider } from "./model-resolver.js";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { TraceCitation } from "./trace-builder.js";
import { parseCitations } from "./citations.js";


// ── Types ───────────────────────────────────────────────────────────────────

interface SessionQA {
  sessionFile: string;
  question: string;
  thinking: string;
  filesRead: { path: string; content: string }[];  // what agent actually saw
  filesAvailable: string[];                          // all sources
  filesSkipped: string[];
  answer: string;
  model: string;
  durationMs: number;
  citations: TraceCitation[];
}

interface EvalIssue {
  type: "citation" | "contradiction" | "wiki-gap" | "wasted-read" | "index-issue";
  severity: "error" | "warning" | "info";
  sessionFile: string;
  question: string;
  detail: string;
  recommendation: string;
}

interface CitationMetrics {
  totalCitations: number;
  withBbox: number;
  withoutBbox: number;
  multiPage: number;
  avgPerAnswer: number;
  answersWithCitations: number;
  answersWithoutCitations: number;
}

interface EvalMetrics {
  totalSessions: number;
  totalQAs: number;
  avgDurationMs: number;
  wikiHits: number;       // answered without reading source files
  sourceReads: number;    // needed source files
  totalFilesRead: number;
  uniqueFilesRead: Map<string, number>; // file → read count
  wastedReads: number;    // files read but not cited in answer
  citations: CitationMetrics;
}

export interface EvalResult {
  metrics: EvalMetrics;
  issues: EvalIssue[];
  wikiGaps: string[];
  timestamp: string;
  agentsInsights: string; // markdown block to inject into AGENTS.md
}

// ── Session parser ──────────────────────────────────────────────────────────

async function parseSessionsForEval(sessionsDir: string, sourcesDir: string, limit?: number): Promise<SessionQA[]> {
  if (!existsSync(sessionsDir)) return [];

  const sessionFiles = (await readdir(sessionsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // newest first

  const files = limit ? sessionFiles.slice(0, limit) : sessionFiles;
  const qas: SessionQA[] = [];

  // Get available source files
  let filesAvailable: string[] = [];
  try {
    filesAvailable = (await readdir(sourcesDir)).filter((f) => f.endsWith(".md"));
  } catch {}

  for (const file of files) {
    try {
      const raw = await readFile(join(sessionsDir, file), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);

      const entries: any[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch {}
      }

      const messages = entries.filter((e) => e.type === "message");

      // Check if this is a query session
      const sessionInfo = entries.find((e) => e.type === "session_info");
      const name: string = sessionInfo?.name ?? "";
      if (!name.startsWith("query:")) continue;

      // Find user questions and their corresponding answers
      let currentQuestion = "";
      let currentThinking = "";
      let currentFilesRead: { path: string; content: string }[] = [];
      let currentAnswer = "";
      let currentModel = "";
      let startTs = 0;
      let endTs = 0;

      for (const entry of messages) {
        const msg = entry.message;
        if (!msg) continue;

        if (msg.role === "user") {
          // If we had a previous Q&A, save it
          if (currentQuestion && currentAnswer) {
            const parsed = parseCitations(currentAnswer);
            qas.push({
              sessionFile: file,
              question: currentQuestion,
              thinking: currentThinking,
              filesRead: currentFilesRead,
              filesAvailable,
              filesSkipped: filesAvailable.filter(
                (f) => !currentFilesRead.some((r) => r.path.endsWith(f))
              ),
              answer: currentAnswer,
              model: currentModel,
              durationMs: endTs - startTs,
              citations: parsed.citations,
            });
          }

          // Start new Q&A
          currentQuestion = extractText(msg.content);
          currentThinking = "";
          currentFilesRead = [];
          currentAnswer = "";
          startTs = new Date(entry.timestamp).getTime();
        }

        if (msg.role === "assistant") {
          currentModel = msg.model ?? "";
          endTs = new Date(entry.timestamp).getTime();

          for (const block of msg.content ?? []) {
            if (block.type === "thinking") currentThinking += block.thinking;
            if (block.type === "text") currentAnswer += block.text;
          }
        }

        if (msg.role === "toolResult" && !msg.isError) {
          // Find the corresponding tool call to get the path
          const toolCallId = msg.toolCallId;
          // Look back for the assistant message with this tool call
          for (const prev of messages) {
            if (prev.message?.role !== "assistant") continue;
            for (const block of prev.message?.content ?? []) {
              if (block.type === "toolCall" && block.id === toolCallId && block.name === "read") {
                const path = block.arguments?.path ?? "";
                const content = extractText(msg.content);
                if (path && content) {
                  currentFilesRead.push({ path, content: content.slice(0, 2000) }); // cap content size
                }
              }
            }
          }
        }
      }

      // Save the last Q&A
      if (currentQuestion && currentAnswer) {
        const parsed = parseCitations(currentAnswer);
        qas.push({
          sessionFile: file,
          question: currentQuestion,
          thinking: currentThinking,
          filesRead: currentFilesRead,
          filesAvailable,
          filesSkipped: filesAvailable.filter(
            (f) => !currentFilesRead.some((r) => r.path.endsWith(f))
          ),
          answer: currentAnswer,
          model: currentModel,
          durationMs: endTs - startTs,
          citations: parsed.citations,
        });
      }
    } catch {
      // Skip malformed session files
    }
  }

  return qas;
}

// ── Metrics calculator ──────────────────────────────────────────────────────

function calculateMetrics(qas: SessionQA[]): EvalMetrics {
  const uniqueFiles = new Map<string, number>();
  let totalFilesRead = 0;
  let wikiHits = 0;
  let sourceReads = 0;
  let wastedReads = 0;
  let totalDuration = 0;

  const uniqueSessions = new Set(qas.map((q) => q.sessionFile));

  for (const qa of qas) {
    totalDuration += qa.durationMs;

    const sourceFilesRead = qa.filesRead.filter(
      (f) => !f.path.includes("index.md") && !f.path.includes("wiki.md")
    );

    if (sourceFilesRead.length === 0) {
      wikiHits++;
    } else {
      sourceReads++;
    }

    for (const f of sourceFilesRead) {
      totalFilesRead++;
      const name = basename(f.path);
      uniqueFiles.set(name, (uniqueFiles.get(name) ?? 0) + 1);

      // Check if this file was actually cited in the answer
      if (!qa.answer.includes(name) && !qa.answer.includes(name.replace(".md", ""))) {
        wastedReads++;
      }
    }
  }

  // Citation metrics
  let totalCitations = 0;
  let withBbox = 0;
  let withoutBbox = 0;
  let multiPage = 0;
  let answersWithCitations = 0;
  let answersWithoutCitations = 0;

  for (const qa of qas) {
    if (qa.citations.length > 0) {
      answersWithCitations++;
      for (const c of qa.citations) {
        totalCitations++;
        if (c.bbox || (c.pages && c.pages.length > 0)) {
          withBbox++;
        } else {
          withoutBbox++;
        }
        if (c.pages && c.pages.length > 0) {
          multiPage++;
        }
      }
    } else {
      answersWithoutCitations++;
    }
  }

  return {
    totalSessions: uniqueSessions.size,
    totalQAs: qas.length,
    avgDurationMs: qas.length > 0 ? totalDuration / qas.length : 0,
    wikiHits,
    sourceReads,
    totalFilesRead,
    uniqueFilesRead: uniqueFiles,
    wastedReads,
    citations: {
      totalCitations,
      withBbox,
      withoutBbox,
      multiPage,
      avgPerAnswer: qas.length > 0 ? totalCitations / qas.length : 0,
      answersWithCitations,
      answersWithoutCitations,
    },
  };
}

// ── LLM judge ───────────────────────────────────────────────────────────────

async function resolveApiKey(authStorage?: AuthStorage): Promise<string | undefined> {
  const result = await resolveApiKeyFromProvider(authStorage);
  if (result) return result.key;
  return process.env.ANTHROPIC_API_KEY;
}

async function judgeQA(
  qa: SessionQA,
  apiKey: string,
  modelId: string
): Promise<EvalIssue[]> {
  const issues: EvalIssue[] = [];
  const model = await resolveModel(modelId);
  if (!model) return issues;

  // Build context for the judge
  const filesSummary = qa.filesRead
    .map((f) => `File: ${basename(f.path)}\nContent (first 2000 chars):\n${f.content}`)
    .join("\n\n---\n\n");

  const skippedList = qa.filesSkipped.join(", ") || "none";

  const prompt = `You are an eval judge for a knowledge base Q&A system.

QUESTION: ${qa.question}

ANSWER:
${qa.answer.slice(0, 3000)}

FILES READ BY AGENT:
${filesSummary || "None — answered from wiki cache"}

FILES AVAILABLE BUT SKIPPED: ${skippedList}

---

Check for these issues and return a JSON array of findings. Each finding has:
- "type": one of "citation", "contradiction", "wiki-gap", "wasted-read"
- "severity": "error" or "warning"
- "detail": what's wrong (one sentence)
- "recommendation": what to fix (one sentence)

Checks:
1. CITATION: Does the answer cite specific sources? If so, does the file content support the claims?
2. CONTRADICTION: Does the answer say anything that contradicts the file content?
3. WIKI-GAP: If the agent read source files (not just wiki), what topic should be added to the wiki so next time it can answer without reading files?
4. WASTED-READ: Were any files read but not actually used in the answer?

Return ONLY a JSON array. If no issues found, return [].
Example: [{"type":"wiki-gap","severity":"warning","detail":"Electronic evidence topic not in wiki","recommendation":"Add electronic evidence section to wiki"}]`;

  try {
    const result = await completeSimple(
      model,
      {
        systemPrompt: "You are a precise QA evaluator. Return only valid JSON arrays. No explanation.",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      { apiKey }
    );

    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();

    // Parse JSON response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const findings = JSON.parse(jsonMatch[0]);
      for (const f of findings) {
        issues.push({
          type: f.type ?? "citation",
          severity: f.severity ?? "warning",
          sessionFile: qa.sessionFile,
          question: qa.question,
          detail: f.detail ?? "",
          recommendation: f.recommendation ?? "",
        });
      }
    }
  } catch {
    // Judge call failed — non-fatal
  }

  return issues;
}

// ── Report writer ───────────────────────────────────────────────────────────

function buildReport(result: EvalResult): string {
  const { metrics, issues, wikiGaps } = result;
  const lines: string[] = [];

  lines.push(`# Eval Report`);
  lines.push(``);
  lines.push(`> ${metrics.totalQAs} queries across ${metrics.totalSessions} sessions · ${result.timestamp}`);
  lines.push(``);

  // Performance
  lines.push(`## Performance`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total queries | ${metrics.totalQAs} |`);
  lines.push(`| Avg duration | ${(metrics.avgDurationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Wiki hits (no file reads) | ${metrics.wikiHits} (${metrics.totalQAs > 0 ? Math.round(metrics.wikiHits / metrics.totalQAs * 100) : 0}%) |`);
  lines.push(`| Needed source files | ${metrics.sourceReads} |`);
  lines.push(`| Total file reads | ${metrics.totalFilesRead} |`);
  lines.push(`| Wasted reads | ${metrics.wastedReads} |`);
  lines.push(``);

  // Citations
  const cm = metrics.citations;
  lines.push(`## Citations`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total citations | ${cm.totalCitations} |`);
  lines.push(`| Avg per answer | ${cm.avgPerAnswer.toFixed(1)} |`);
  lines.push(`| With bbox | ${cm.withBbox} (${cm.totalCitations > 0 ? Math.round(cm.withBbox / cm.totalCitations * 100) : 0}%) |`);
  lines.push(`| Without bbox | ${cm.withoutBbox} |`);
  lines.push(`| Multi-page | ${cm.multiPage} |`);
  lines.push(`| Answers with citations | ${cm.answersWithCitations}/${metrics.totalQAs} (${metrics.totalQAs > 0 ? Math.round(cm.answersWithCitations / metrics.totalQAs * 100) : 0}%) |`);
  lines.push(``);

  // Most read files
  if (metrics.uniqueFilesRead.size > 0) {
    lines.push(`### Most Read Files`);
    lines.push(``);
    const sorted = [...metrics.uniqueFilesRead.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`| File | Times Read |`);
    lines.push(`|---|---|`);
    for (const [file, count] of sorted.slice(0, 10)) {
      lines.push(`| ${file} | ${count} |`);
    }
    lines.push(``);
  }

  // Issues
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (errors.length > 0) {
    lines.push(`## 🔴 Errors (${errors.length})`);
    lines.push(``);
    for (const issue of errors) {
      lines.push(`### ${issue.type}: ${issue.detail}`);
      lines.push(`- **Query:** ${issue.question}`);
      lines.push(`- **Recommendation:** ${issue.recommendation}`);
      lines.push(``);
    }
  }

  if (warnings.length > 0) {
    lines.push(`## 🟡 Warnings (${warnings.length})`);
    lines.push(``);
    for (const issue of warnings) {
      lines.push(`### ${issue.type}: ${issue.detail}`);
      lines.push(`- **Query:** ${issue.question}`);
      lines.push(`- **Recommendation:** ${issue.recommendation}`);
      lines.push(``);
    }
  }

  // Wiki gaps
  if (wikiGaps.length > 0) {
    lines.push(`## 📝 Wiki Gaps (auto-fixable)`);
    lines.push(``);
    for (const gap of wikiGaps) {
      lines.push(`- ${gap}`);
    }
    lines.push(``);
  }

  if (errors.length === 0 && warnings.length === 0 && wikiGaps.length === 0) {
    lines.push(`## ✅ No issues found`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Agents insights (injected into AGENTS.md) ──────────────────────────────

function buildAgentsInsights(result: EvalResult): string {
  const { metrics, issues, wikiGaps } = result;
  const lines: string[] = [];

  lines.push(`## Eval Insights (auto-generated ${result.timestamp.slice(0, 10)})`);
  lines.push(``);

  // Wiki gaps — tell the agent to fill these
  if (wikiGaps.length > 0) {
    lines.push(`### Wiki Gaps — add to wiki when users ask about these topics`);
    for (const gap of wikiGaps.slice(0, 15)) { // cap at 15 to avoid context bloat
      lines.push(`- ${gap}`);
    }
    lines.push(``);
  }

  // Behaviour fixes from errors
  const citationErrors = issues.filter((i) => i.type === "citation" && i.severity === "error");
  const contradictions = issues.filter((i) => i.type === "contradiction");
  if (citationErrors.length > 0 || contradictions.length > 0) {
    lines.push(`### Behaviour Fixes`);
    if (citationErrors.some((i) => i.detail.includes("wiki cache"))) {
      lines.push(`- Do NOT claim "I read the actual document" when answering from wiki. Say "Based on the knowledge wiki" instead.`);
    }
    if (contradictions.length > 0) {
      lines.push(`- Double-check claims against source text before stating them as fact.`);
    }
    if (metrics.wastedReads > 10) {
      lines.push(`- Be more selective with file reads. Last eval found ${metrics.wastedReads} wasted reads (files read but not cited).`);
    }
    lines.push(``);
  }

  // Most-read files — tell agent to prefer wiki for these
  if (metrics.uniqueFilesRead.size > 0) {
    const sorted = [...metrics.uniqueFilesRead.entries()].sort((a, b) => b[1] - a[1]);
    const heavy = sorted.filter(([, count]) => count >= 3);
    if (heavy.length > 0) {
      lines.push(`### Heavily-Read Files — prefer wiki knowledge over re-reading these`);
      for (const [file, count] of heavy.slice(0, 5)) {
        lines.push(`- ${file} (read ${count} times)`);
      }
      lines.push(``);
    }
  }

  // Citation quality
  const cm = metrics.citations;
  if (cm.totalCitations > 0) {
    const bboxRate = Math.round(cm.withBbox / cm.totalCitations * 100);
    lines.push(`### Citation Quality`);
    lines.push(`- Bbox coverage: ${bboxRate}% (target: 100%)`);
    lines.push(`- Avg citations per answer: ${cm.avgPerAnswer.toFixed(1)}`);
    if (cm.withoutBbox > 0) {
      lines.push(`- ${cm.withoutBbox} citations missing bbox — agent should always read .json files`);
    }
    if (cm.answersWithoutCitations > 0) {
      lines.push(`- ${cm.answersWithoutCitations} answers had no citations — every answer must cite sources`);
    }
    lines.push(``);
  }

  // Performance note
  const hitRate = metrics.totalQAs > 0 ? Math.round(metrics.wikiHits / metrics.totalQAs * 100) : 0;
  lines.push(`### Performance`);
  lines.push(`- Wiki hit rate: ${hitRate}% (target: 80%+)`);
  lines.push(`- Avg query time: ${(metrics.avgDurationMs / 1000).toFixed(1)}s`);
  lines.push(``);

  return lines.join("\n");
}

// ── Main eval function ──────────────────────────────────────────────────────

export async function runEval(
  kbRoot: string,
  options: { authStorage?: AuthStorage; last?: number; onProgress?: (msg: string) => void }
): Promise<EvalResult> {
  const sessionsDir = join(kbRoot, ".llm-kb", "sessions");
  const sourcesDir = join(kbRoot, ".llm-kb", "wiki", "sources");
  const log = options.onProgress ?? (() => {});

  // 1. Parse sessions
  log("Reading sessions...");
  const qas = await parseSessionsForEval(sessionsDir, sourcesDir, options.last);
  log(`Found ${qas.length} Q&A exchanges across sessions`);

  if (qas.length === 0) {
    return {
      metrics: { totalSessions: 0, totalQAs: 0, avgDurationMs: 0, wikiHits: 0, sourceReads: 0, totalFilesRead: 0, uniqueFilesRead: new Map(), wastedReads: 0, citations: { totalCitations: 0, withBbox: 0, withoutBbox: 0, multiPage: 0, avgPerAnswer: 0, answersWithCitations: 0, answersWithoutCitations: 0 } },
      issues: [],
      wikiGaps: [],
      timestamp: new Date().toISOString(),
    };
  }

  // 2. Calculate metrics
  log("Calculating metrics...");
  const metrics = calculateMetrics(qas);

  // 3. Run LLM judge on each Q&A
  const apiKey = await resolveApiKey(options.authStorage);
  const allIssues: EvalIssue[] = [];

  if (apiKey) {
    const modelId = "claude-haiku-4-5";
    for (let i = 0; i < qas.length; i++) {
      log(`Judging ${i + 1}/${qas.length}: "${qas[i].question.slice(0, 50)}..."`);
      const issues = await judgeQA(qas[i], apiKey, modelId);
      allIssues.push(...issues);
    }
  } else {
    log("No API key — skipping LLM judge checks");
  }

  // 4. Extract wiki gaps
  const wikiGaps = allIssues
    .filter((i) => i.type === "wiki-gap")
    .map((i) => i.detail);

  const result: EvalResult = {
    metrics,
    issues: allIssues.filter((i) => i.type !== "wiki-gap"),
    wikiGaps,
    timestamp: new Date().toISOString(),
    agentsInsights: "",
  };

  // 5. Build agents insights (injected into AGENTS.md on next query)
  result.agentsInsights = buildAgentsInsights(result);

  // 6. Write report + insights file
  log("Writing eval report + insights...");
  const outputsDir = join(kbRoot, ".llm-kb", "wiki", "outputs");
  await mkdir(outputsDir, { recursive: true });

  const report = buildReport(result);
  await writeFile(join(outputsDir, "eval-report.md"), report, "utf-8");

  // Save insights to guidelines.md (section-aware: preserve user rules)
  const guidelinesPath = join(kbRoot, ".llm-kb", "guidelines.md");
  await writeGuidelines(guidelinesPath, result.agentsInsights);
  log("Insights saved to .llm-kb/guidelines.md (agent reads on-demand)");

  return result;
}

// ── Guidelines (section-aware write) ────────────────────────────────────────

const EVAL_SECTION_START = "## Eval Insights";
const EVAL_SECTION_RE = /## Eval Insights[\s\S]*?(?=\n## |$)/;

export async function writeGuidelines(path: string, evalSection: string): Promise<void> {
  let existing = "";
  try { existing = await readFile(path, "utf-8"); } catch {}

  if (!existing) {
    // First time — just write the eval section
    await writeFile(path, evalSection, "utf-8");
    return;
  }

  if (EVAL_SECTION_RE.test(existing)) {
    // Replace existing eval section, preserve everything else
    await writeFile(path, existing.replace(EVAL_SECTION_RE, evalSection.trim()), "utf-8");
  } else {
    // File exists but no eval section — prepend it
    await writeFile(path, evalSection + "\n\n" + existing, "utf-8");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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
