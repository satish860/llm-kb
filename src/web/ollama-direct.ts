import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { updateWiki } from "../wiki-updater.js";
import { saveTrace, appendToQueryLog, KBTrace } from "../trace-builder.js";

/**
 * Direct Ollama chat bridge — bypasses the pi-coding-agent framework entirely.
 * Reads source documents, builds context, and streams responses from Ollama's
 * OpenAI-compatible API. This is necessary because small local models (llama3 8B)
 * cannot reliably follow the complex multi-tool agent instructions.
 */

interface WSLike {
  send(data: string): void;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const OLLAMA_BASE = "http://127.0.0.1:11434";

export async function createOllamaDirectSession(
  folder: string,
  ws: WSLike,
  options: { modelId?: string }
): Promise<{ prompt: (text: string) => Promise<void>; dispose: () => void }> {

  const modelId = options.modelId || "llama3";
  const kbDir = join(folder, ".llm-kb");
  const sourcesDir = join(kbDir, "wiki", "sources");

  // Load all source markdown files into memory for context
  let sourceContext = "";
  let mdFiles: string[] = [];
  try {
    const files = await readdir(sourcesDir);
    mdFiles = files.filter(f => f.endsWith(".md"));
    for (const f of mdFiles) {
      const content = await readFile(join(sourcesDir, f), "utf-8");
      // Truncate very large files to first 3000 chars to fit context window
      const trimmed = content.length > 3000 ? content.slice(0, 3000) + "\n...[truncated]" : content;
      sourceContext += `\n--- SOURCE: ${f} ---\n${trimmed}\n`;
    }
  } catch (e) {
    console.error("[ollama-direct] Failed to read sources:", e);
  }

  // Load wiki if it exists
  let wikiContext = "";
  const wikiPath = join(kbDir, "wiki", "wiki.md");
  if (existsSync(wikiPath)) {
    try {
      wikiContext = await readFile(wikiPath, "utf-8");
    } catch {}
  }

  const systemPrompt = `You are a helpful knowledge base assistant. Answer questions based ONLY on the provided source documents below. If you cannot find the answer in the sources, say so clearly.

When citing information, mention the source filename and page number if available.

${wikiContext ? `## Wiki Knowledge\n${wikiContext}\n\n---\n` : ""}
## Source Documents
${sourceContext}

---
Instructions:
- Answer the user's question based on the source documents above
- Be specific and cite which source document the information comes from
- If the answer is not in the sources, say "I could not find this information in the available documents"
- Keep answers clear and well-organized`;

  // Conversation history for multi-turn
  const history: OllamaMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  const send = (data: any) => {
    try { ws.send(JSON.stringify(data)); } catch (e) {
      console.error("[ollama-direct] WS send failed:", e);
    }
  };

  async function prompt(text: string): Promise<void> {
    const startTime = Date.now();

    // Add user message to history
    history.push({ role: "user", content: text });

    // Notify UI
    send({ type: "status", model: modelId });
    send({ type: "thinking_start" });

    try {
      // Call Ollama streaming API
      const response = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: history,
          stream: true,
        }),
      });

      send({ type: "thinking_end" });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama returned ${response.status}: ${errText}`);
      }

      send({ type: "text_start" });

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body from Ollama");

      const decoder = new TextDecoder();
      let fullAnswer = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullAnswer += delta;
              send({ type: "text_delta", text: delta });
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      send({ type: "text_end" });

      // Add assistant response to history
      history.push({ role: "assistant", content: fullAnswer });

      const elapsedMs = Date.now() - startTime;
      const elapsed = elapsedMs / 1000;
      send({
        type: "done",
        elapsed: Math.round(elapsed * 10) / 10,
        filesRead: 0,
        citationCount: 0,
      });

      // Background process: build trace, save it, update query log & wiki
      try {
        const traceSessionId = `ui-${Date.now()}`;
        const trace: KBTrace = {
          sessionId: traceSessionId,
          sessionFile: `${traceSessionId}.jsonl`,
          timestamp: new Date().toISOString(),
          mode: "query",
          question: text,
          answer: fullAnswer,
          answerWithoutCitations: fullAnswer,
          filesRead: mdFiles,
          filesAvailable: mdFiles,
          filesSkipped: [],
          model: modelId,
          durationMs: elapsedMs,
          citations: []
        };
        
        // Fire-and-forget
        saveTrace(folder, trace).catch(() => {});
        appendToQueryLog(folder, trace).catch(() => {});
        updateWiki(folder, trace, undefined, modelId).catch(console.error);
      } catch (err) {
        console.error("[ollama-direct] Error during trace/wiki update:", err);
      }

    } catch (err: any) {
      send({ type: "thinking_end" });
      send({ type: "error", message: `Ollama error: ${err.message}` });
      console.error("[ollama-direct] Error:", err);
    }
  }

  return {
    prompt,
    dispose() {
      // Nothing to dispose for direct HTTP
    },
  };
}
