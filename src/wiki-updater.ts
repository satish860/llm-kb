import { getModels, completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { KBTrace } from "./trace-builder.js";

async function resolveApiKey(authStorage?: AuthStorage): Promise<string | undefined> {
  if (authStorage) {
    return authStorage.getApiKey("anthropic");
  }
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(piAuthPath)) {
    const storage = AuthStorage.create(piAuthPath);
    return storage.getApiKey("anthropic");
  }
  return process.env.ANTHROPIC_API_KEY;
}

function buildPrompt(
  question: string,
  answer: string,
  sources: string,
  date: string,
  currentWiki: string
): string {
  const rules = `Rules for wiki structure:
- Use ## for CONCEPTS and TOPICS — NOT source file names
  Good: "## Electronic Evidence", "## Mob Lynching", "## Burden of Proof"
  Bad: "## Indian Evidence Act.md", "## indian penal code - new.md"
- Use ### for subtopics within a concept
- A concept can draw from MULTIPLE source files — synthesize, don't separate by file
- If knowledge from this Q&A fits an existing concept, ADD to it — never duplicate
- If it's a genuinely new concept, create a new ## section
- Be concise: bullet points for lists, short prose for explanations
- Include source citations inline: (Source: filename, p.X)
- Add cross-references where concepts relate: See also: [[Other Concept]]
- End each ## section with: *Sources: file1, file2 · date*
- Separate ## sections with: ---`;

  if (currentWiki.trim()) {
    return `You are maintaining a concept-organized knowledge wiki.

## Current wiki
${currentWiki}

## New Q&A to integrate
**Question:** ${question}
**Sources used:** ${sources}
**Date:** ${date}

**Answer:**
${answer}

---

Update the wiki to integrate this new knowledge.
${rules}

Return ONLY the complete updated wiki markdown. No explanation.`;
  }

  return `You are creating a concept-organized knowledge wiki.

## First Q&A to add
**Question:** ${question}
**Sources used:** ${sources}
**Date:** ${date}

**Answer:**
${answer}

---

Create a clean wiki from this Q&A.
- Start with: # Knowledge Wiki\\n\\n> Concept-organized knowledge base. Updated after each query.\\n\\n---
${rules}

Return ONLY the wiki markdown. No explanation.`;
}

/**
 * Update .llm-kb/wiki/wiki.md using a direct Haiku call.
 * Organizes knowledge by CONCEPT (cross-cutting topics),
 * not by source file.
 */
export async function updateWiki(
  kbRoot: string,
  trace: KBTrace,
  authStorage?: AuthStorage,
  indexModelId = "claude-haiku-4-5"
): Promise<void> {
  if (trace.mode !== "query" || !trace.question || !trace.answer) return;

  const wikiDir = join(kbRoot, ".llm-kb", "wiki");
  await mkdir(wikiDir, { recursive: true });
  const wikiPath = join(wikiDir, "wiki.md");

  const currentWiki = existsSync(wikiPath)
    ? await readFile(wikiPath, "utf-8").catch(() => "")
    : "";

  const sources = trace.filesRead
    .map((f) => f.split(/[\\/]/).pop() ?? f)
    .filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "wiki.md")
    .join(", ") || "unknown";

  const date = new Date(trace.timestamp).toISOString().slice(0, 10);
  const prompt = buildPrompt(trace.question, trace.answer, sources, date, currentWiki);

  const apiKey = await resolveApiKey(authStorage);
  if (!apiKey) return;

  const model = getModels("anthropic").find((m) => m.id === indexModelId);
  if (!model) return;

  const result = await completeSimple(
    model,
    {
      systemPrompt: "You are a precise knowledge librarian. Organize information by CONCEPT, not by source file. Synthesize knowledge from multiple sources into unified topic articles. Return only clean markdown.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    { apiKey }
  );

  const text = result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("")
    .trim();

  if (text) {
    await writeFile(wikiPath, text + "\n", "utf-8");
  }
}
