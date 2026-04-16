import { AuthStorage } from "@mariozechner/pi-coding-agent";
import chalk from "chalk";

export type AuthMethod = "pi-sdk" | "api-key" | "none" | "ollama";

export interface AuthResult {
  ok: true;
  method: AuthMethod;
  authStorage?: AuthStorage; // undefined = use Pi SDK default (file-based)
}

export interface AuthFailure {
  ok: false;
}

/**
 * Detect available auth and return an AuthStorage if needed.
 * For local Ollama we always succeed without any keys.
 */
export function checkAuth(): AuthResult | AuthFailure {
  const authStorage = AuthStorage.inMemory({
    openai: { type: "api_key", key: "dummy-ollama-key" } // Needed since Ollama acts as an OpenAI-compatible provider
  });
  return { ok: true, method: "ollama", authStorage };
}

/**
 * Print a friendly error when no auth is configured and exit.
 */
export function exitWithAuthError(): never {
  console.error(chalk.red("\n  Failed to connect to local Ollama. Please ensure Ollama is running.\n"));
  process.exit(1);
}
