import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import chalk from "chalk";

export type AuthMethod = "pi-sdk" | "env" | "none";

export interface AuthResult {
  ok: true;
  method: AuthMethod;
  authStorage?: AuthStorage; // undefined = use Pi SDK default (file-based)
  providers: string[];
}

export interface AuthFailure {
  ok: false;
}

/**
 * Detect available auth and return an AuthStorage if needed.
 *
 * Priority:
 * 1. Pi SDK auth.json  → use file-based storage (can include multiple providers)
 * 2. Env vars          → create in-memory storage with any available provider keys
 * 3. Neither           → return failure
 */
export function checkAuth(): AuthResult | AuthFailure {
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");

  if (existsSync(piAuthPath)) {
    const authStorage = AuthStorage.create();
    return { ok: true, method: "pi-sdk", authStorage, providers: ["pi-sdk"] };
  }

  const providers: Record<string, { type: "api_key"; key: string }> = {};
  const names: string[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = { type: "api_key", key: process.env.ANTHROPIC_API_KEY };
    names.push("anthropic");
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.openrouter = { type: "api_key", key: process.env.OPENROUTER_API_KEY };
    names.push("openrouter");
  }
  if (process.env.OPENAI_API_KEY) {
    providers.openai = { type: "api_key", key: process.env.OPENAI_API_KEY };
    names.push("openai");
  }

  if (names.length > 0) {
    const authStorage = AuthStorage.inMemory(providers);
    return { ok: true, method: "env", authStorage, providers: names };
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
  console.error(`  ${chalk.bold("Option 2:")} Set one or more provider API keys`);
  console.error(chalk.dim("    export ANTHROPIC_API_KEY=sk-ant-..."));
  console.error(chalk.dim("    export OPENROUTER_API_KEY=sk-or-..."));
  console.error(chalk.dim("    export OPENAI_API_KEY=sk-...\n"));
  process.exit(1);
}
