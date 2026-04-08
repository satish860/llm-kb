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
import { existsSync } from "node:fs";
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
    wikiSection,
    `## ${sourceStep}`,
    ``,
    `1. Read .llm-kb/wiki/index.md to understand all available sources`,
    `2. Select the most relevant source files (usually 2-5) and read them in full`,
    `3. Answer with inline citations: (filename, page number)`,
    `4. If you can't find the answer, say so — don't hallucinate`,
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
    `## Citation Format`,
    `Use numbered references [1], [2], etc. inline in your answer.`,
    `After your answer, ALWAYS include a CITATIONS block with bounding box data.`,
    ``,
    `### How to build citations with bounding boxes:`,
    `1. When you read a source .md file (e.g. "document.md"), note the exact quote and page number`,
    `2. Read the corresponding .json file in the SAME directory (e.g. "document.json")`,
    `3. The JSON file contains bounding box data for every text item on every page`,
    `4. Find the textItems that contain your quoted text on the cited page`,
    `5. Include the bounding box coordinates in your citation`,
    `6. IMPORTANT: Even when answering from the wiki, you MUST still read the .json`,
    `   files to find bounding boxes. The wiki has page numbers — use them to look up bbox.`,
    ``,
    `### Citation block format:`,
    ``,
    `Single page:`,
    `CITATIONS:`,
    `[1] file: "document.pdf", page: 3, quote: "exact text", bbox: {x: 142, y: 340, width: 234, height: 14}`,
    ``,
    `Multi-page (when a quote spans a page boundary):`,
    `[2] file: "document.pdf", pages: [17, 18], quote: "text that spans two pages", bbox: [{page: 17, x: 100, y: 750, width: 400, height: 14}, {page: 18, x: 100, y: 107, width: 350, height: 14}]`,
    ``,
    `### Rules:`,
    `- Use the ORIGINAL filename (the .pdf name), not the .md parsed version`,
    `  The .json files have a "source" field with the original PDF name — use that`,
    `- The quote MUST be EXACT text from the source`,
    `- ALWAYS read the .json file to find bounding boxes — even for wiki-sourced answers`,
    `- The bbox should be the merged rectangle covering all textItems that make up the quote`,
    `- If you cannot find the bbox, omit the bbox field but still include the citation`,
    `- Every factual claim must have at least one citation`,
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
      if (ui) { ui.showCompletion(); ui.enableInput(); }
      else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const source = filesReadCount > 0
          ? `${filesReadCount} file${filesReadCount !== 1 ? "s" : ""} read` : "wiki";
        const stats = `${elapsed}s \u00b7 ${source}`;
        const cols = process.stdout.columns || 80;
        const pad = Math.max(0, cols - stats.length - 4);
        process.stdout.write(`\n\n${dim("\u2500\u2500 " + stats + " " + "\u2500".repeat(pad))}\n`);
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
  const wikiContent = existsSync(wikiPath) ? await readFile(wikiPath, "utf-8").catch(() => "") : "";
  const agentsContent = buildQueryAgents(mdFiles, !!options.save, wikiContent);

  const loader = new DefaultResourceLoader({
    cwd: folder,
    agentsFilesOverride: (current) => ({
      agentsFiles: [...current.agentsFiles, { path: ".llm-kb/AGENTS.md", content: agentsContent }],
    }),
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

  return { session, display };
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
