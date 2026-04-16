import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { KBTrace, TraceCitation } from "./trace-builder.js";



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
- Also append related user queries at the end of the section as: *User query: "the exact user question"*
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
  authStorage?: any,
  indexModelId = "llama3"
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

  try {
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: indexModelId || "llama3",
        messages: [
          { role: "system", content: "You are a precise knowledge librarian. Organize information by CONCEPT, not by source file. Synthesize knowledge from multiple sources into unified topic articles. ALWAYS preserve page-level citations (Source: filename, p.X) for every fact. Return only clean markdown." },
          { role: "user", content: prompt }
        ],
        stream: true
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body from Ollama");

    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) text += parsed.message.content;
        } catch { /* skip */ }
      }
    }

    text = text.trim();
    if (text) {
      await writeFile(wikiPath, text + "\n", "utf-8");
    }
  } catch (err: any) {
    console.error("[wiki-updater] Failed to update wiki:", err.message);
  }
}
