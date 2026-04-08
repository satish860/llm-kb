import { completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { KBTrace, TraceCitation } from "./trace-builder.js";
import { resolveModel, resolveApiKey as resolveApiKeyFromProvider } from "./model-resolver.js";

async function resolveApiKey(authStorage?: AuthStorage): Promise<string | undefined> {
  const result = await resolveApiKeyFromProvider(authStorage);
  if (result) return result.key;
  return process.env.ANTHROPIC_API_KEY;
}

function formatCitationsForWiki(citations: TraceCitation[]): string {
  if (citations.length === 0) return "";
  const lines = citations.map((c, i) =>
    `  [${i + 1}] ${c.file}, p.${c.page}: "${c.quote}"`
  );
  return `\n\n**Verified citations (preserve page numbers in wiki):**\n${lines.join("\n")}`;
}

function buildPrompt(
  question: string,
  answer: string,
  sources: string,
  date: string,
  currentWiki: string,
  citations?: TraceCitation[]
): string {
  const citationsSection = citations && citations.length > 0
    ? formatCitationsForWiki(citations)
    : "";

  const rules = `Rules for wiki structure:
- Use ## for CONCEPTS and TOPICS — NOT source file names
  Good: "## Electronic Evidence", "## Mob Lynching", "## Burden of Proof"
  Bad: "## Indian Evidence Act.md", "## indian penal code - new.md"
- Use ### for subtopics within a concept
- A concept can draw from MULTIPLE source files — synthesize, don't separate by file
- If knowledge from this Q&A fits an existing concept, ADD to it — never duplicate
- If it's a genuinely new concept, create a new ## section
- Be concise: bullet points for lists, short prose for explanations
- ALWAYS include source citations with page numbers inline: (Source: filename, p.X)
- Every factual claim must have a page-level citation — this is critical for verification
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
${answer}${citationsSection}

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
${answer}${citationsSection}

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
  // Use clean answer (without CITATIONS block) + pass structured citations separately
  const answer = trace.answerWithoutCitations ?? trace.answer;
  const prompt = buildPrompt(trace.question, answer, sources, date, currentWiki, trace.citations);

  const apiKey = await resolveApiKey(authStorage);
  if (!apiKey) return;

  const model = await resolveModel(indexModelId, authStorage);
  if (!model) return;

  const result = await completeSimple(
    model,
    {
      systemPrompt: "You are a precise knowledge librarian. Organize information by CONCEPT, not by source file. Synthesize knowledge from multiple sources into unified topic articles. ALWAYS preserve page-level citations (Source: filename, p.X) for every fact. Return only clean markdown.",
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
