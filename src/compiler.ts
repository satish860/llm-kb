import {
  createAgentSession,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";
import { readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getNodeModulesPath } from "./utils.js";

function buildCompilerAgents(sourceFiles: string[]): string {
  const sourceList = sourceFiles.map((f) => `  - ${f}`).join("\n");

  return `# llm-kb — Article Compiler

You are a knowledge librarian. Your job is to read all source documents and compile them
into a set of concept-organized articles — like a mini Wikipedia for this document collection.

## Source files available (in .llm-kb/wiki/sources/)
${sourceList}

## What to do

1. Read .llm-kb/wiki/index.md to understand all sources at a glance
2. Read each source file to understand its content (first 1000-2000 chars is often enough to identify key topics)
3. Identify 10-30 key CONCEPTS across all sources
   - A concept = a topic, provision, entity, comparison, or theme
   - Think: what would a Wikipedia article about this collection cover?
4. Write one .md file per concept to .llm-kb/wiki/articles/
5. Write .llm-kb/wiki/articles/index.md — the concept catalog

## Article format

Each article file should follow this structure:

\`\`\`markdown
# [Concept Title]

## Overview
One paragraph explaining what this concept is.

## Key Details
The substance — bullet points, tables, specifics.
Extract from sources, don't summarize vaguely.

## Related Articles
- [[other-article-name]] — one-line description of the relationship

*Sources: source-file-1.md (p.X), source-file-2.md (p.Y)*
\`\`\`

## The articles/index.md catalog

Write this LAST, after all articles exist:

\`\`\`markdown
# Knowledge Articles

> Compiled from ${sourceFiles.length} source documents.

| Article | Description |
|---|---|
| [[article-name]] | One-line summary |
| [[another-article]] | One-line summary |
\`\`\`

## Rules
- Article filenames: lowercase, hyphens, no spaces (e.g. mob-lynching.md)
- Be SPECIFIC — extract actual clause numbers, section numbers, dates, names
- Backlinks use [[filename-without-extension]] format
- Every article MUST have source citations
- Don't create articles for trivial topics — focus on substantive concepts
- Cross-reference heavily — the power is in the links between articles
- Write articles/index.md LAST so it reflects all articles you created

## Directory
Write all files to: .llm-kb/wiki/articles/
`;
}

/**
 * Check if articles are up to date (articles/index.md newer than all sources).
 */
async function articlesUpToDate(sourcesDir: string, articlesDir: string): Promise<boolean> {
  const articlesIndex = join(articlesDir, "index.md");
  if (!existsSync(articlesIndex)) return false;

  try {
    const indexMtime = (await stat(articlesIndex)).mtimeMs;
    const sourceFiles = await readdir(sourcesDir);
    const mtimes = await Promise.all(
      sourceFiles.map((f) => stat(join(sourcesDir, f)).then((s) => s.mtimeMs))
    );
    return mtimes.every((mt) => indexMtime >= mt);
  } catch {
    return false;
  }
}

/**
 * Compile concept articles from all source files.
 * Uses Sonnet — needs strong reasoning to synthesize across sources.
 */
export async function compileArticles(
  folder: string,
  sourcesDir: string,
  authStorage?: AuthStorage,
  modelId?: string
): Promise<{ articleCount: number; skipped: boolean }> {
  const articlesDir = join(folder, ".llm-kb", "wiki", "articles");

  // Skip if up to date
  if (await articlesUpToDate(sourcesDir, articlesDir)) {
    return { articleCount: 0, skipped: true };
  }

  await mkdir(articlesDir, { recursive: true });

  const files = await readdir(sourcesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  if (mdFiles.length === 0) {
    throw new Error("No source files found to compile");
  }

  const agentsContent = buildCompilerAgents(mdFiles);

  process.env.NODE_PATH = getNodeModulesPath();

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

  const model = modelId
    ? getModels("anthropic").find((m) => m.id === modelId)
    : undefined;

  const { session } = await createAgentSession({
    cwd: folder,
    resourceLoader: loader,
    tools: [createReadTool(folder), createWriteTool(folder)],
    sessionManager: SessionManager.inMemory(), // compile sessions don't need persistence
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    ...(authStorage ? { authStorage } : {}),
    ...(model ? { model } : {}),
  });

  session.setSessionName(`compile: ${new Date().toISOString()}`);

  const prompt = `Read the index and all source files in .llm-kb/wiki/sources/, then compile concept articles to .llm-kb/wiki/articles/.

Create one article per key concept. Write articles/index.md last as the catalog.

Focus on the most important concepts — typically 10-30 articles for a document collection.`;

  await session.prompt(prompt);
  session.dispose();

  // Count articles written
  let articleCount = 0;
  try {
    const articlesFiles = await readdir(articlesDir);
    articleCount = articlesFiles.filter((f) => f.endsWith(".md") && f !== "index.md").length;
  } catch {}

  return { articleCount, skipped: false };
}
