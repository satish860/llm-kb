import {
  createAgentSession,
  createBashTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { resolveModelCandidates } from "./model-resolver.js";
import { readdir, readFile } from "node:fs/promises";
import { createKBSession } from "./session-store.js";
import { getNodeModulesPath } from "./utils.js";
import { join } from "node:path";

function buildAgentsContent(sourcesDir: string, files: string[]): string {
  const sourceList = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => `  - ${f}`)
    .join("\n");

  return `# llm-kb Knowledge Base

## How to access documents

### PDFs (pre-parsed)
PDFs have been parsed to markdown with bounding boxes.
Read the markdown versions in \`.llm-kb/wiki/sources/\` instead of the raw PDFs.

Available parsed sources:
${sourceList}

### Other file types (Excel, Word, PowerPoint)
You have bash and read tools. Use bash to run Node.js scripts.
Libraries are pre-installed via require().

For .docx (structured XML — ZIP containing word/document.xml):
  const AdmZip = require('adm-zip');
  const zip = new AdmZip('file.docx');
  const xml = zip.readAsText('word/document.xml');
  // Parse XML to extract headings and first paragraphs for summary

For .xlsx use exceljs:
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('file.xlsx');
  const sheet = wb.getWorksheet(1);

For .pptx use officeparser:
  const officeparser = require('officeparser');
  const text = await officeparser.parseOfficeAsync('file.pptx');

## Index file
Write the index to \`.llm-kb/wiki/index.md\`.

The index should be a markdown file with:
1. A title and last-updated timestamp
2. A summary table with columns: Source, Type, Pages/Size, Summary, Key Topics
3. Each source gets a one-line summary (read the first ~500 chars of each file to generate it)
4. Total word count across all sources
`;
}

export async function buildIndex(
  folder: string,
  sourcesDir: string,
  onOutput?: (text: string) => void,
  authStorage?: AuthStorage,
  modelId?: string
): Promise<string> {
  // List source files
  const files = await readdir(sourcesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  if (mdFiles.length === 0) {
    throw new Error("No source files found to index");
  }

  // Build AGENTS.md content
  const agentsContent = buildAgentsContent(sourcesDir, files);

  // Set NODE_PATH so agent's bash scripts can use bundled libraries
  const nodeModulesPath = getNodeModulesPath();
  process.env.NODE_PATH = nodeModulesPath;

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

  const candidates = modelId
    ? await resolveModelCandidates(modelId, authStorage, "index")
    : [];

  if (modelId && candidates.length === 0) {
    throw new Error(`No usable model found for '${modelId}'. Configure Anthropic, OpenRouter, or OpenAI credentials.`);
  }

  // Build the prompt
  const prompt = `Read each file in .llm-kb/wiki/sources/ (one at a time, just the first 500 characters of each).
Then write .llm-kb/wiki/index.md with a summary table of all sources.

Include: Source filename, Type (PDF/Excel/Word/etc), Pages (from the JSON if available), a one-line summary, and key topics.
Add a total word count estimate at the bottom.`;

  const indexPath = join(sourcesDir, "..", "index.md");
  const attemptCandidates = candidates.length > 0
    ? candidates
    : [{ provider: "default", candidateId: "default", model: undefined as any }];
  let lastError: unknown;

  for (let i = 0; i < attemptCandidates.length; i++) {
    const candidate = attemptCandidates[i]!;
    const { session } = await createAgentSession({
      cwd: folder,
      resourceLoader: loader,
      tools: [
        createReadTool(folder),
        createBashTool(folder),
        createWriteTool(folder),
      ],
      sessionManager: await createKBSession(folder),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
      }),
      ...(authStorage ? { authStorage } : {}),
      ...(candidate.model ? { model: candidate.model } : {}),
    });

    if (onOutput) {
      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          onOutput(event.assistantMessageEvent.delta);
        }
      });
    }

    session.setSessionName(`index: ${new Date().toISOString()}`);

    try {
      await session.prompt(prompt);
      const content = await readFile(indexPath, "utf-8");
      session.dispose();
      return content;
    } catch (error) {
      lastError = error;
      session.dispose();
      const next = attemptCandidates[i + 1];
      if (next) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`  Index attempt failed on ${candidate.provider}:${candidate.model?.id ?? candidate.candidateId} (${detail}). Retrying with ${next.provider}:${next.model?.id ?? next.candidateId}...`);
        continue;
      }
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Agent did not create index.md");
}
