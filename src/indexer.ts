import {
  createAgentSession,
  createBashTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find the node_modules directory for llm-kb's bundled libraries.
 * When running from bin/cli.js, node_modules is at ../node_modules.
 */
function getNodeModulesPath(): string {
  // Walk up from this file to find node_modules
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "node_modules");
    try {
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  return join(process.cwd(), "node_modules");
}

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

### Other file types (Excel, Word, PowerPoint, CSV, images)
You have bash and read tools. These libraries are pre-installed and available:
- **exceljs** — for .xlsx/.xls files
- **mammoth** — for .docx files  
- **officeparser** — for .pptx files
- **csv-parse** — built into Node.js, use fs + split for .csv

Write a quick Node.js script to extract content when needed.

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
  onOutput?: (text: string) => void
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

  const { session } = await createAgentSession({
    cwd: folder,
    resourceLoader: loader,
    tools: [
      createReadTool(folder),
      createBashTool(folder),
      createWriteTool(folder),
    ],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
    }),
  });

  // Subscribe to streaming output
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

  // Build the prompt
  const prompt = `Read each file in .llm-kb/wiki/sources/ (one at a time, just the first 500 characters of each).
Then write .llm-kb/wiki/index.md with a summary table of all sources.

Include: Source filename, Type (PDF/Excel/Word/etc), Pages (from the JSON if available), a one-line summary, and key topics.
Add a total word count estimate at the bottom.`;

  await session.prompt(prompt);

  // Read the generated index
  const indexPath = join(sourcesDir, "..", "index.md");
  try {
    const content = await readFile(indexPath, "utf-8");
    session.dispose();
    return content;
  } catch {
    session.dispose();
    throw new Error("Agent did not create index.md");
  }
}
