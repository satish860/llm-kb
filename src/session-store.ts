import { SessionManager } from "@mariozechner/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Continue the most recent session, or create a new one if none exists.
 * Sessions persist in .llm-kb/sessions/ — conversation history survives restarts.
 */
export async function continueKBSession(kbRoot: string): Promise<SessionManager> {
  const sessionDir = join(kbRoot, ".llm-kb", "sessions");
  await mkdir(sessionDir, { recursive: true });
  return SessionManager.continueRecent(kbRoot, sessionDir);
}

/**
 * Always create a fresh session (for one-shot `llm-kb query` or indexing).
 */
export async function createKBSession(kbRoot: string): Promise<SessionManager> {
  const sessionDir = join(kbRoot, ".llm-kb", "sessions");
  await mkdir(sessionDir, { recursive: true });
  return SessionManager.create(kbRoot, sessionDir);
}
