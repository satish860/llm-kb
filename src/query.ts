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
import { getModels } from "@mariozechner/pi-ai";
import { readdir, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createKBSession } from "./session-store.js";
import { saveTrace, appendToQueryLog, KBTrace } from "./trace-builder.js";
import { updateWiki } from "./wiki-updater.js";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Shared helpers ──────────────────────────────────────────────────────────

function getNodeModulesPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "node_modules");
    try { return candidate; } catch { dir = dirname(dir); }
  }
  return join(process.cwd(), "node_modules");
}

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
    return `Running  ${(args.command as string).trim().split("\n")[0].slice(0, 60)}`;
  }
  return null;
}

// ── AGENTS.md builder ───────────────────────────────────────────────────────

function buildQueryAgents(sourceFiles: string[], save: boolean, wikiContent: string): string {
  const sourceList = sourceFiles.map((f) => `  - ${f}`).join("\n");

  const wikiSection = wikiContent
    ? `## Knowledge Wiki (use this first)

The wiki below contains knowledge already extracted from this knowledge base.
If the user's question is covered here, answer directly from it — no need to re-read source files.
Always cite the original source files mentioned in the wiki.

${wikiContent}

---

`
    : "";

  const sourceStep = wikiContent ? "If not covered in the wiki above: read the sources" : "How to answer";

  let content = `# llm-kb Knowledge Base — Query Mode

${wikiSection}## ${sourceStep}

1. Read .llm-kb/wiki/index.md to understand all available sources
2. Select the most relevant source files (usually 2-5) and read them in full
3. Answer with inline citations: (filename, page number)
4. If you can't find the answer, say so — don't hallucinate

## Available parsed sources
${sourceList}

## Non-PDF files
If the user's folder has Excel, Word, or PowerPoint files, these libraries are available:
- **exceljs** — for .xlsx/.xls files
- **mammoth** — for .docx files
- **officeparser** — for .pptx files
Write a quick Node.js script via bash to read them.

## Rules
- Always cite sources with filename and page number
- Read the FULL source file, not just the beginning
- Prefer primary sources over previous analyses
`;

  if (save) {
    content += `
## Research Mode
Save your analysis to .llm-kb/wiki/outputs/ with a descriptive filename (e.g., comparison-analysis.md).
Include the question at the top and all citations.
`;
  }

  return content;
}

// ── Display subscriber ──────────────────────────────────────────────────────
//
// Claude Web UI-style output:
//
//   ⟡ claude-sonnet-4-6
//
//   ▸ Thinking
//     The user wants to know about...
//
//   ▸ Reading  index.md
//   ▸ Reading  Indian Evidence Act.md
//
//   ──────────────────────────────────
//
//   ## The Indian Evidence Act...
//   (answer streams)
//
//   ── 4.2s · 2 files read ──────────
//

function subscribeDisplay(
  session: AgentSession,
  opts: { modelId?: string; authStorage?: AuthStorage; folder: string; mdFiles: string[] }
) {
  const dim = (s: string) => process.stdout.isTTY ? chalk.dim(s) : s;
  const thinLine = () => {
    const cols = process.stdout.columns || 80;
    return dim("\u2500".repeat(cols));
  };

  // Per-prompt state — reset on agent_start
  let phase: "idle" | "thinking" | "tools" | "answer" = "idle";
  let filesReadCount = 0;
  let shownToolCalls = new Set<string>();
  let startTime = Date.now();

  // Wiki update scheduler — persistent across prompts
  const scheduler = new WikiUpdateScheduler(5, 3);

  const buildTraceFromMessages = (messages: any[], question: string): KBTrace | null => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.stopReason === "stop");
    if (!lastAssistant) return null;
    const filesRead = extractFilesRead(messages);
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      timestamp: new Date().toISOString(),
      mode: "query",
      question,
      answer: extractAnswerText(lastAssistant.content),
      filesRead,
      filesAvailable: opts.mdFiles,
      filesSkipped: opts.mdFiles.filter((f) => !filesRead.some((r) => r.endsWith(f))),
      model: lastAssistant.model,
    };
  };

  // Track the latest user question for trace building
  let lastQuestion = "";

  const doUpdate = async (messages: any[]) => {
    const trace = buildTraceFromMessages(messages, lastQuestion);
    if (!trace) return;
    await saveTrace(opts.folder, trace);
    await appendToQueryLog(opts.folder, trace);
    await updateWiki(opts.folder, trace, opts.authStorage);
  };

  session.subscribe((event) => {

    // ═══ Reset on each prompt cycle ═══════════════════════════════════════
    if (event.type === "agent_start") {
      phase = "idle";
      filesReadCount = 0;
      shownToolCalls = new Set();
      startTime = Date.now();
    }

    // ═══ 1. Model header ═════════════════════════════════════════════════
    if (event.type === "turn_start" && phase === "idle") {
      const modelName = opts.modelId ?? "claude-sonnet-4-6";
      process.stdout.write(dim(`\u27e1 ${modelName}`) + "\n");
    }

    // ═══ 2. Thinking ═════════════════════════════════════════════════════
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "thinking_start") {
        process.stdout.write(dim("\n\u25b8 Thinking\n"));
        phase = "thinking";
      }
      if (ae.type === "thinking_delta") {
        process.stdout.write(dim(`  ${ae.delta}`));
      }
      if (ae.type === "thinking_end") {
        process.stdout.write("\n");
      }
    }

    // ═══ 3. Tool calls ═══════════════════════════════════════════════════
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent as any;
      if (ae.type === "toolcall_end" && ae.toolCall) {
        const label = getToolLabel(ae.toolCall.name, ae.toolCall.arguments);
        if (label) {
          if (phase !== "tools") {
            process.stdout.write("\n");
            phase = "tools";
          }
          process.stdout.write(dim(`  \u25b8 ${label}`) + "\n");
          shownToolCalls.add(ae.toolCall.id);
          if (ae.toolCall.name === "read") filesReadCount++;
        }
      }
    }

    if (event.type === "tool_execution_start") {
      const { toolCallId, toolName, args } = event as any;
      if (!shownToolCalls.has(toolCallId)) {
        const label = getToolLabel(toolName, args);
        if (label) {
          if (phase !== "tools") {
            process.stdout.write("\n");
            phase = "tools";
          }
          process.stdout.write(dim(`  \u25b8 ${label}`) + "\n");
          shownToolCalls.add(toolCallId);
          if (toolName === "read") filesReadCount++;
        }
      }
    }

    // ═══ 4. Answer ═══════════════════════════════════════════════════════
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_start" && phase !== "answer") {
        if (phase === "thinking" || phase === "tools") {
          process.stdout.write(`\n${thinLine()}\n\n`);
        }
        phase = "answer";
      }
      if (ae.type === "text_delta") {
        process.stdout.write(ae.delta);
      }
    }

    // ═══ 5. Completion bar ═══════════════════════════════════════════════
    if (event.type === "agent_end") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const source = filesReadCount > 0
        ? `${filesReadCount} file${filesReadCount !== 1 ? "s" : ""} read`
        : "wiki";
      const stats = `${elapsed}s \u00b7 ${source}`;
      const cols = process.stdout.columns || 80;
      const pad = Math.max(0, cols - stats.length - 4);
      process.stdout.write(`\n\n${dim("\u2500\u2500 " + stats + " " + "\u2500".repeat(pad))}\n`);

      scheduler.onAgentEnd(event.messages as any[], doUpdate);
    }

    // ═══ Wiki throttle ═══════════════════════════════════════════════════
    if (event.type === "message_end") {
      scheduler.onMessageEnd(
        event.message,
        () => ({ messages: session.state.messages as any[] }),
        doUpdate
      );
    }
  });

  return {
    /** Set the question text for trace building (call before session.prompt) */
    setQuestion(q: string) { lastQuestion = q; },
    /** Wait for any pending wiki updates to finish */
    flush() { return scheduler.flush(); },
  };
}

// ── Wiki update scheduler ───────────────────────────────────────────────────

class WikiUpdateScheduler {
  private stopMsgCount = 0;
  private lastUpdateAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly everyNMessages: number,
    private readonly everyMinutes: number
  ) {}

  private shouldUpdate(): boolean {
    const countTrigger = this.stopMsgCount > 0 && this.stopMsgCount % this.everyNMessages === 0;
    const timeTrigger =
      this.lastUpdateAt > 0 &&
      Date.now() - this.lastUpdateAt > this.everyMinutes * 60_000;
    return countTrigger || timeTrigger;
  }

  private enqueue(work: () => Promise<void>) {
    this.chain = this.chain.then(() => work().catch(() => {}));
  }

  onMessageEnd(message: any, getSnapshot: () => { messages: any[] }, doUpdate: (msgs: any[]) => Promise<void>) {
    if (message.role !== "assistant" || message.stopReason !== "stop") return;
    this.stopMsgCount++;
    if (this.shouldUpdate()) {
      this.lastUpdateAt = Date.now();
      const { messages } = getSnapshot();
      this.enqueue(() => doUpdate(messages));
    }
  }

  onAgentEnd(messages: any[], doUpdate: (msgs: any[]) => Promise<void>) {
    this.lastUpdateAt = Date.now();
    this.enqueue(() => doUpdate(messages));
  }

  flush(): Promise<void> { return this.chain; }
}

// ── Session factory (shared by chat and one-shot query) ─────────────────────

export interface ChatSession {
  session: AgentSession;
  display: ReturnType<typeof subscribeDisplay>;
}

export async function createChat(
  folder: string,
  options: { save?: boolean; authStorage?: AuthStorage; modelId?: string }
): Promise<ChatSession> {
  const sourcesDir = join(folder, ".llm-kb", "wiki", "sources");
  const files = await readdir(sourcesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  if (mdFiles.length === 0) {
    throw new Error("No sources found. Run 'llm-kb run' first to parse documents.");
  }

  if (options.save) {
    await mkdir(join(folder, ".llm-kb", "wiki", "outputs"), { recursive: true });
  }

  process.env.NODE_PATH = getNodeModulesPath();

  const wikiPath = join(folder, ".llm-kb", "wiki", "wiki.md");
  const wikiContent = existsSync(wikiPath)
    ? await readFile(wikiPath, "utf-8").catch(() => "")
    : "";

  const agentsContent = buildQueryAgents(mdFiles, !!options.save, wikiContent);

  const loader = new DefaultResourceLoader({
    cwd: folder,
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        { path: ".llm-kb/AGENTS.md", content: agentsContent },
      ],
    }),
  });
  await loader.reload();

  const tools = [createReadTool(folder)];
  if (options.save) {
    tools.push(createBashTool(folder), createWriteTool(folder));
  }

  const model = options.modelId
    ? getModels("anthropic").find((m) => m.id === options.modelId)
    : undefined;

  const { session } = await createAgentSession({
    cwd: folder,
    resourceLoader: loader,
    tools,
    sessionManager: await createKBSession(folder),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
    }),
    thinkingLevel: "low",
    ...(options.authStorage ? { authStorage: options.authStorage } : {}),
    ...(model ? { model } : {}),
  });

  const display = subscribeDisplay(session, {
    modelId: options.modelId,
    authStorage: options.authStorage,
    folder,
    mdFiles,
  });

  return { session, display };
}

// ── One-shot query (for `llm-kb query` command) ─────────────────────────────

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
