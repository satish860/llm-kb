import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import chalk from "chalk";

export type AuthMethod = "pi-sdk" | "api-key" | "none";

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
 *
 * Priority:
 * 1. Pi SDK auth.json  → use default file-based storage (no override needed)
 * 2. ANTHROPIC_API_KEY → create in-memory storage with the key
 * 3. Neither           → return failure
 */
export function checkAuth(): AuthResult | AuthFailure {
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");

  if (existsSync(piAuthPath)) {
    const authStorage = AuthStorage.create();
    return { ok: true, method: "pi-sdk", authStorage };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: process.env.ANTHROPIC_API_KEY },
    });
    return { ok: true, method: "api-key", authStorage };
  }

  return { ok: false };
}

/**
 * Print a friendly error when no auth is configured and exit.
 */
export function exitWithAuthError(): never {
  console.error(chalk.red("\n  No LLM authentication found.\n"));
  console.error(`  ${chalk.bold("Option 1:")} Install Pi SDK ${chalk.dim("(recommended)")}`);
  console.error(chalk.dim("    npm install -g @mariozechner/pi-coding-agent"));
  console.error(chalk.dim("    pi\n"));
  console.error(`  ${chalk.bold("Option 2:")} Set your Anthropic API key`);
  console.error(chalk.dim("    export ANTHROPIC_API_KEY=sk-ant-...\n"));
  process.exit(1);
}
