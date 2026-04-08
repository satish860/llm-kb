import {
  createAgentSession,
  createBashTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  SettingsManager,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "./model-resolver.js";
import { readdir, mkdir, readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createKBSession, continueKBSession } from "./session-store.js";
import { saveTrace, appendToQueryLog, type KBTrace } from "./trace-builder.js";
import { parseCitations } from "./citations.js";
import { updateWiki } from "./wiki-updater.js";
import { join, basename } from "node:path";
import chalk from "chalk";
import { getNodeModulesPath } from "./utils.js";
import { MarkdownStream } from "./md-stream.js";
import type { ChatDisplay } from "./tui-display.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractAnswerText(content: any[]): string {
  return (content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text ?? "")
    .join("")
    .trim();
}

function extractFilesRead(messages: any[]): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content ?? []) {
      if (block.type === "toolCall" && block.name === "read") {
        const p: string = block.arguments?.path ?? "";
        if (p && !paths.includes(p)) paths.push(p);
      }
    }
  }
  return paths;
}

function getToolLabel(toolName: string, args: any): string | null {
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const file = basename((args?.path as string) ?? "");
    if (!file || !/\.[a-z0-9]{1,6}$/i.test(file)) return null;
    const verb = toolName === "read" ? "Reading" : toolName === "write" ? "Writing" : "Editing";
    return `${verb}  ${file}`;
  }
  if (toolName === "bash" && args?.command) {
    return `Running  bash`;
  }
  return null;
}

// ── AGENTS.md ───────────────────────────────────────────────────────────────

function buildQueryAgents(sourceFiles: string[], save: boolean, wikiContent: string): string {
  const sourceList = sourceFiles.map((f) => `  - ${f}`).join("\n");
  const wikiSection = wikiContent
    ? `## Knowledge Wiki (use this first)\n\nThe wiki below contains knowledge already extracted from this knowledge base.\nIf the user's question is covered here, answer directly from it — no need to re-read source files.\nAlways cite the original source files mentioned in the wiki.\n\n${wikiContent}\n\n---\n\n`
    : "";
  const sourceStep = wikiContent ? "If not covered in the wiki above: read the sources" : "How to answer";

  const lines = [
    `# llm-kb Knowledge Base — Query Mode`,
    ``,
    `## MANDATORY: Citation Format`,
    `Every answer MUST end with a CITATIONS block. No exceptions. Even for simple or wiki-sourced answers.`,
    `EVERY citation MUST have a bbox. Do NOT submit any citation without bbox.`,
    ``,
    `Use [1], [2], etc. inline in your answer, then include:`,
    ``,
    `CITATIONS:`,
    `[1] file: "document.pdf", page: 3, quote: "exact text from source", bbox: {x: 142, y: 340, width: 234, height: 14}`,
    ``,
    `To get the bbox for EACH citation:`,
    `1. Read the .json file in .llm-kb/wiki/sources/ (same name as the .md file but .json)`,
    `2. Use bash + node to search the textItems on the cited page`,
    `3. Compute the merged bbox from matching textItems`,
    ``,
    `You can look up ALL citations in a single bash script. Example:`,
    "```",
    `node -e "`,
    `  const fs = require('fs');`,
    `  // Citation 1: file X, page Y`,
    `  const d1 = JSON.parse(fs.readFileSync('.llm-kb/wiki/sources/FILE1.json','utf8'));`,
    `  const p1 = d1.pages.find(p=>p.page===PAGE1);`,
    `  const items1 = p1.textItems.filter(t=>t.text.includes('KEYWORD1'));`,
    `  console.log('C1 source:', d1.source, 'bbox:', JSON.stringify(items1.map(t=>({x:t.x,y:t.y,w:t.width,h:t.height}))));`,
    `  // Citation 2: file X, page Z`,
    `  const d2 = JSON.parse(fs.readFileSync('.llm-kb/wiki/sources/FILE2.json','utf8'));`,
    `  const p2 = d2.pages.find(p=>p.page===PAGE2);`,
    `  const items2 = p2.textItems.filter(t=>t.text.includes('KEYWORD2'));`,
    `  console.log('C2 source:', d2.source, 'bbox:', JSON.stringify(items2.map(t=>({x:t.x,y:t.y,w:t.width,h:t.height}))));`,
    `"`,
    "```",
    ``,
    `The .json file has a "source" field — use that as the filename (it's the original .pdf name).`,
    `If answering from wiki, the wiki has (Source: filename, p.X) — use that page number for the .json lookup.`,
    ``,
    wikiSection,
    `## ${sourceStep}`,
    ``,
    `1. Read .llm-kb/wiki/index.md to understand all available sources`,
    `2. Select the most relevant source files (usually 2-5) and read them in full`,
    `3. Answer the question with [1], [2] inline references`,
    `4. If you can't find the answer, say so — don't hallucinate`,
    `5. ALWAYS end with a CITATIONS block (see top of this file)`,
    ``,
    `## Available parsed sources`,
    sourceList,
    ``,
    `## Non-PDF files (docx, xlsx, pptx)`,
    `Use bash to run Node.js scripts. Libraries are pre-installed via require().`,
    ``,
    `### Word (.docx) — structured XML`,
    `.docx files are ZIP archives containing word/document.xml.`,
    `Read them SELECTIVELY — extract only what is relevant to the question:`,
    ``,
    "```javascript",
    `const AdmZip = require('adm-zip');`,
    `const zip = new AdmZip('file.docx');`,
    `const xml = zip.readAsText('word/document.xml');`,
    `// Parse XML to find specific paragraphs, headings, tables`,
    "```",
    ``,
    `Strategy for large .docx files:`,
    `1. First: extract headings/structure to understand the document layout`,
    `2. Then: extract only the sections relevant to the user's question`,
    `NEVER dump the entire document.`,
    ``,
    `### Excel (.xlsx) — use exceljs`,
    `Read specific sheets and ranges, not the whole workbook:`,
    ``,
    "```javascript",
    `const ExcelJS = require('exceljs');`,
    `const wb = new ExcelJS.Workbook();`,
    `await wb.xlsx.readFile('file.xlsx');`,
    `const sheet = wb.getWorksheet(1);`,
    `// Read specific rows/columns relevant to the question`,
    "```",
    ``,
    `### PowerPoint (.pptx) — use officeparser`,
    ``,
    "```javascript",
    `const officeparser = require('officeparser');`,
    `const text = await officeparser.parseOfficeAsync('file.pptx');`,
    "```",
    ``,
    `## Rules`,
    `- Always cite sources with filename and page number`,
    `- Read the FULL source file, not just the beginning (for .md sources)`,
    `- For non-PDF files, extract ONLY relevant sections — never dump entire files`,
    `- Prefer primary sources over previous analyses`,
    ``,

    `## Guidelines`,
    `A guidelines file may exist at .llm-kb/guidelines.md with learned rules from`,
    `past evaluations and user preferences. Read it when:`,
    `- You're unsure about citation accuracy or format`,
    `- You're about to read source files (guidelines may suggest using wiki instead)`,
    `- The question touches a topic that may have had issues in past evaluations`,
  ];

  if (save) {
    lines.push(``, `## Research Mode`, `Save your analysis to .llm-kb/wiki/outputs/ with a descriptive filename.`, `Include the question at the top and all citations.`);
  }

  return lines.join("\n");
}

// ── Wiki update scheduler ───────────────────────────────────────────────────

class WikiUpdateScheduler {
  private stopMsgCount = 0;
  private lastUpdateAt = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly everyN: number, private readonly everyMin: number) {}
  private shouldUpdate() {
    return (this.stopMsgCount > 0 && this.stopMsgCount % this.everyN === 0) ||
      (this.lastUpdateAt > 0 && Date.now() - this.lastUpdateAt > this.everyMin * 60_000);
  }
  private enqueue(work: () => Promise<void>) { this.chain = this.chain.then(() => work().catch(() => {})); }
  onMessageEnd(msg: any, snap: () => { messages: any[] }, doUpdate: (m: any[]) => Promise<void>) {
    if (msg.role !== "assistant" || msg.stopReason !== "stop") return;
    this.stopMsgCount++;
    if (this.shouldUpdate()) { this.lastUpdateAt = Date.now(); this.enqueue(() => doUpdate(snap().messages)); }
  }
  onAgentEnd(msgs: any[], doUpdate: (m: any[]) => Promise<void>) {
    this.lastUpdateAt = Date.now(); this.enqueue(() => doUpdate(msgs));
  }
  flush() { return this.chain; }
}

// ── Display subscriber ──────────────────────────────────────────────────────
// Routes events to either TUI components (interactive) or stdout (one-shot)

function subscribeDisplay(
  session: AgentSession,
  opts: {
    modelId?: string;
    authStorage?: AuthStorage;
    folder: string;
    mdFiles: string[];
    tuiDisplay?: ChatDisplay;
  }
) {
  const ui = opts.tuiDisplay;
  const dim = (s: string) => process.stdout.isTTY ? chalk.dim(s) : s;
  const thinLine = () => dim("\u2500".repeat(process.stdout.columns || 80));

  let phase: "idle" | "thinking" | "tools" | "answer" = "idle";
  let filesReadCount = 0;
  let shownToolCalls = new Set<string>();
  let startTime = Date.now();
  let md = new MarkdownStream(process.stdout.isTTY ?? false);
  let lastQuestion = "";

  const scheduler = new WikiUpdateScheduler(5, 3);

  const buildTrace = (messages: any[]): KBTrace | null => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.stopReason === "stop");
    if (!last) return null;
    const filesRead = extractFilesRead(messages);
    const fullAnswer = extractAnswerText(last.content);
    const parsed = parseCitations(fullAnswer);
    return {
      sessionId: session.sessionId, sessionFile: session.sessionFile ?? "",
      timestamp: new Date().toISOString(), mode: "query", question: lastQuestion,
      answer: fullAnswer,
      answerWithoutCitations: parsed.answer,
      citations: parsed.citations.length > 0 ? parsed.citations : undefined,
      filesRead,
      filesAvailable: opts.mdFiles,
      filesSkipped: opts.mdFiles.filter((f) => !filesRead.some((r) => r.endsWith(f))),
      model: last.model,
    };
  };

  const doUpdate = async (messages: any[]) => {
    const trace = buildTrace(messages);
    if (!trace) return;
    await saveTrace(opts.folder, trace);
    await appendToQueryLog(opts.folder, trace);
    await updateWiki(opts.folder, trace, opts.authStorage);
  };

  session.subscribe((event) => {

    // ── Reset ────────────────────────────────────────────────────────────
    if (event.type === "agent_start") {
      phase = "idle";
      filesReadCount = 0;
      shownToolCalls = new Set();
      startTime = Date.now();
      md = new MarkdownStream(process.stdout.isTTY ?? false);
      const modelName = opts.modelId ?? "claude-sonnet-4-6";
      if (ui) { ui.disableInput(); ui.beginResponse(modelName); }
      else process.stdout.write(dim(`\u27e1 ${modelName}`) + "\n");
    }

    // ── Thinking ─────────────────────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "thinking_start") {
        if (!ui) process.stdout.write(dim("\n\u25b8 Thinking\n"));
        phase = "thinking";
      }
      if (ae.type === "thinking_delta") {
        if (ui) ui.appendThinking(ae.delta);
        else process.stdout.write(dim(`  ${ae.delta}`));
      }
      if (ae.type === "thinking_end") {
        if (ui) ui.endThinking();
        else process.stdout.write("\n");
      }
    }

    // ── Tool calls ───────────────────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent as any;
      if (ae.type === "toolcall_end" && ae.toolCall) {
        const label = getToolLabel(ae.toolCall.name, ae.toolCall.arguments);
        if (label) {
          if (!ui && phase !== "tools") process.stdout.write("\n");
          phase = "tools";
          if (ui) {
            ui.addToolCall(ae.toolCall.id, label, ae.toolCall.name);
            // Show the actual bash code the agent wrote
            if (ae.toolCall.name === "bash" && ae.toolCall.arguments?.command) {
              ui.addCodeBlock(ae.toolCall.arguments.command);
            }
          } else {
            process.stdout.write(dim(`  \u25b8 ${label}`) + "\n");
            // Show bash code in stdout mode too
            if (ae.toolCall.name === "bash" && ae.toolCall.arguments?.command) {
              const code = ae.toolCall.arguments.command as string;
              process.stdout.write(dim(code.split("\n").map(l => `    ${l}`).join("\n")) + "\n");
            }
            shownToolCalls.add(ae.toolCall.id);
            if (ae.toolCall.name === "read") filesReadCount++;
          }
        }
      }
    }

    if (event.type === "tool_execution_start") {
      const { toolCallId, toolName, args } = event as any;
      if (ui) {
        const label = getToolLabel(toolName, args);
        if (label) ui.addToolCall(toolCallId, label, toolName);
      } else if (!shownToolCalls.has(toolCallId)) {
        const label = getToolLabel(toolName, args);
        if (label) {
          if (phase !== "tools") process.stdout.write("\n");
          phase = "tools";
          process.stdout.write(dim(`  \u25b8 ${label}`) + "\n");
          shownToolCalls.add(toolCallId);
          if (toolName === "read") filesReadCount++;
        }
      }
    }

    // tool result (show errors)
    if (event.type === "tool_execution_end") {
      const { toolCallId, isError } = event as any;
      if (ui) ui.addToolResult(toolCallId, isError);
    }

    // ── Answer ───────────────────────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_start" && phase !== "answer") {
        if (ui) ui.beginAnswer();
        else if (phase === "thinking" || phase === "tools") {
          process.stdout.write(`\n${thinLine()}\n\n`);
        }
        phase = "answer";
      }
      if (ae.type === "text_delta") {
        if (ui) ui.appendAnswer(ae.delta);
        else process.stdout.write(md.push(ae.delta));
      }
      if (ae.type === "text_end" && !ui) process.stdout.write(md.end());
    }

    // ── Completion ───────────────────────────────────────────────────────
    if (event.type === "agent_end") {
      // Parse citations from the full answer
      const trace = buildTrace(event.messages as any[]);
      const citations = trace?.citations ?? [];

      if (ui) { ui.showCompletion(citations); ui.enableInput(); }
      else {
        // Stdout mode: show citation footer
        if (citations.length > 0) {
          process.stdout.write(`\n${dim("\u2500\u2500 Citations " + "\u2500".repeat(Math.max(0, (process.stdout.columns || 80) - 14)))}\n`);
          for (let i = 0; i < citations.length; i++) {
            const c = citations[i];
            const pageStr = c.pages && c.pages.length > 0
              ? `p.${c.pages.map((p: any) => p.page).join("-")}`
              : `p.${c.page}`;
            const hasBbox = c.bbox || (c.pages && c.pages.length > 0);
            let bboxDetail: string;
            if (c.pages && c.pages.length > 0) {
              bboxDetail = `\u2705 bbox (${c.pages.length} pages)`;
            } else if (c.bbox) {
              bboxDetail = `\u2705 bbox (${c.bbox.x},${c.bbox.y} \u2192 ${Math.round(c.bbox.x + c.bbox.width)},${Math.round(c.bbox.y + c.bbox.height)})`;
            } else {
              bboxDetail = `\u26a0\ufe0f  no bbox`;
            }
            const quote = c.quote.length > 60 ? c.quote.slice(0, 57) + "..." : c.quote;
            process.stdout.write(`\n  ${chalk.bold(`[${i + 1}]`)} \ud83d\udcc4 ${c.file}, ${pageStr}\n`);
            process.stdout.write(dim(`      "${quote}"`) + "\n");
            process.stdout.write(`      ${bboxDetail}\n`);
          }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const source = filesReadCount > 0
          ? `${filesReadCount} file${filesReadCount !== 1 ? "s" : ""} read` : "wiki";
        const citCount = citations.length > 0
          ? ` \u00b7 ${citations.length} citation${citations.length !== 1 ? "s" : ""}` : "";
        const stats = `${elapsed}s \u00b7 ${source}${citCount}`;
        const cols = process.stdout.columns || 80;
        const pad = Math.max(0, cols - stats.length - 4);
        process.stdout.write(`\n${dim("\u2500\u2500 " + stats + " " + "\u2500".repeat(pad))}\n`);
      }
      scheduler.onAgentEnd(event.messages as any[], doUpdate);
    }

    // ── Wiki throttle ────────────────────────────────────────────────────
    if (event.type === "message_end") {
      scheduler.onMessageEnd(event.message, () => ({ messages: session.state.messages as any[] }), doUpdate);
    }
  });

  return {
    setQuestion(q: string) { lastQuestion = q; },
    flush() { return scheduler.flush(); },
  };
}

// ── Session factory ─────────────────────────────────────────────────────────

export interface ChatSession {
  session: AgentSession;
  display: ReturnType<typeof subscribeDisplay>;
  /** Call after new files are parsed & re-indexed so the agent sees them */
  reloadSources(): Promise<void>;
}

export async function createChat(
  folder: string,
  options: { save?: boolean; authStorage?: AuthStorage; modelId?: string; tuiDisplay?: ChatDisplay }
): Promise<ChatSession> {
  const sourcesDir = join(folder, ".llm-kb", "wiki", "sources");
  const files = await readdir(sourcesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) throw new Error("No sources found. Run 'llm-kb run' first.");
  if (options.save) await mkdir(join(folder, ".llm-kb", "wiki", "outputs"), { recursive: true });

  process.env.NODE_PATH = getNodeModulesPath();

  const wikiPath = join(folder, ".llm-kb", "wiki", "wiki.md");
  const save = !!options.save;

  // Build AGENTS.md dynamically on every reload so new files are picked up
  const loader = new DefaultResourceLoader({
    cwd: folder,
    agentsFilesOverride: (current) => {
      const currentFiles = readdirSync(sourcesDir).filter((f: string) => f.endsWith(".md"));
      const wiki = existsSync(wikiPath) ? readFileSync(wikiPath, "utf-8") : "";
      const content = buildQueryAgents(currentFiles, save, wiki);
      return {
        agentsFiles: [...current.agentsFiles, { path: ".llm-kb/AGENTS.md", content }],
      };
    },
  });
  await loader.reload();

  // Always include all tools — agent needs bash for .docx/.xlsx reading
  const tools = [
    createReadTool(folder),
    createBashTool(folder),
    createWriteTool(folder),
  ];

  const model = options.modelId ? await resolveModel(options.modelId, options.authStorage) : undefined;

  const { session } = await createAgentSession({
    cwd: folder,
    resourceLoader: loader,
    tools,
    sessionManager: options.save ? await createKBSession(folder) : await continueKBSession(folder),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    thinkingLevel: "low",
    ...(options.authStorage ? { authStorage: options.authStorage } : {}),
    ...(model ? { model } : {}),
  });

  const display = subscribeDisplay(session, {
    modelId: options.modelId, authStorage: options.authStorage,
    folder, mdFiles, tuiDisplay: options.tuiDisplay,
  });

  async function reloadSources() {
    await loader.reload();
    await session.reload();
  }

  return { session, display, reloadSources };
}

// ── One-shot query (stdout mode, for `llm-kb query` command) ────────────────

export async function query(
  folder: string,
  question: string,
  options: { save?: boolean; authStorage?: AuthStorage; modelId?: string }
): Promise<void> {
  const { session, display } = await createChat(folder, options);
  session.setSessionName(`query: ${question}`);
  display.setQuestion(question);
  await session.prompt(question);
  await display.flush();
  session.dispose();
  if (options.save) {
    const sourcesDir = join(folder, ".llm-kb", "wiki", "sources");
    const { buildIndex } = await import("./indexer.js");
    await buildIndex(folder, sourcesDir, undefined, options.authStorage);
  }
}
