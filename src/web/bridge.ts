import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createChat } from "../query.js";
import { parseCitations } from "../citations.js";
import { basename } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

interface WSLike {
  send(data: string): void;
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

// ── Bridge ──────────────────────────────────────────────────────────────────

export async function createWebChatSession(
  folder: string,
  ws: WSLike,
  options: { authStorage?: AuthStorage; modelId?: string }
): Promise<{ prompt: (text: string) => Promise<void>; dispose: () => void }> {

  const { session, display } = await createChat(folder, {
    authStorage: options.authStorage,
    modelId: options.modelId,
  });

  const send = (data: any) => {
    try { ws.send(JSON.stringify(data)); } catch (e) {
      console.error("[bridge] WS send failed:", e);
    }
  };

  let startTime = Date.now();
  let filesReadCount = 0;
  let shownToolCalls = new Set<string>();
  let accumulatedAnswer = "";

  session.subscribe((event) => {
    // ── Agent start ──────────────────────────────────────────
    if (event.type === "agent_start") {
      startTime = Date.now();
      filesReadCount = 0;
      shownToolCalls = new Set();
      accumulatedAnswer = "";
      const modelName = options.modelId ?? "claude-sonnet-4-6";
      send({ type: "status", model: modelName });
    }

    // ── Thinking ─────────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "thinking_start") send({ type: "thinking_start" });
      if (ae.type === "thinking_delta") send({ type: "thinking_delta", text: ae.delta });
      if (ae.type === "thinking_end") send({ type: "thinking_end" });
    }

    // ── Tool calls ───────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent as any;
      if (ae.type === "toolcall_end" && ae.toolCall) {
        const label = getToolLabel(ae.toolCall.name, ae.toolCall.arguments);
        if (label && !shownToolCalls.has(ae.toolCall.id)) {
          shownToolCalls.add(ae.toolCall.id);
          if (ae.toolCall.name === "read") filesReadCount++;
          send({ type: "tool_start", id: ae.toolCall.id, label, name: ae.toolCall.name });
        }
      }
    }

    if (event.type === "tool_execution_start") {
      const { toolCallId, toolName, args } = event as any;
      if (!shownToolCalls.has(toolCallId)) {
        const label = getToolLabel(toolName, args);
        if (label) {
          shownToolCalls.add(toolCallId);
          if (toolName === "read") filesReadCount++;
          send({ type: "tool_start", id: toolCallId, label, name: toolName });
        }
      }
    }

    if (event.type === "tool_execution_end") {
      const { toolCallId, isError } = event as any;
      send({ type: "tool_end", id: toolCallId, isError });
    }

    // ── Answer text ──────────────────────────────────────────
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_start") send({ type: "text_start" });
      if (ae.type === "text_delta") {
        accumulatedAnswer += ae.delta;
        send({ type: "text_delta", text: ae.delta });
      }
      if (ae.type === "text_end") send({ type: "text_end" });
    }

    // ── Completion ───────────────────────────────────────────
    if (event.type === "agent_end") {
      const elapsed = (Date.now() - startTime) / 1000;

      // Build the full answer from ALL assistant text blocks in the conversation
      // The CITATIONS block could be in any assistant message, not just the last one
      const messages = event.messages as any[];
      let fullAnswer = "";
      for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        for (const block of msg.content ?? []) {
          if (block.type === "text" && block.text) {
            fullAnswer += block.text;
          }
        }
      }

      // Parse citations from the full answer (or streamed accumulation as fallback)
      const textToSearch = fullAnswer || accumulatedAnswer;
      const parsed = parseCitations(textToSearch);
      console.log(`[bridge] Full answer: ${fullAnswer.length} chars, streamed: ${accumulatedAnswer.length} chars, citations: ${parsed.citations.length}`);
      // Debug: show last 300 chars to see if CITATIONS block is there
      if (parsed.citations.length === 0 && textToSearch.length > 0) {
        console.log(`[bridge] No citations found. Last 300 chars: ...${textToSearch.slice(-300)}`);
      }
      if (parsed.citations.length > 0) {
        send({ type: "citations", data: parsed.citations });
      }

      send({
        type: "done",
        elapsed: Math.round(elapsed * 10) / 10,
        filesRead: filesReadCount,
        citationCount: parsed.citations.length,
        answer: parsed.answer,
      });
    }
  });

  return {
    async prompt(text: string) {
      display.setQuestion(text);
      session.setSessionName(`query: ${text}`);
      await session.prompt(text);
      await display.flush();
    },
    dispose() {
      session.dispose();
    },
  };
}
