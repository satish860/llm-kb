import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_INDEX_MODEL = "llama3";
export const DEFAULT_QUERY_MODEL = "llama3";

export interface KBConfig {
  indexModel: string;
  queryModel: string;
}

const DEFAULTS: KBConfig = {
  indexModel: DEFAULT_INDEX_MODEL,
  queryModel: DEFAULT_QUERY_MODEL,
};

function configPath(kbRoot: string): string {
  return join(kbRoot, ".llm-kb", "config.json");
}

/**
 * Load config from .llm-kb/config.json, applying env var overrides.
 *
 * Priority: env var > config file > defaults
 */
export async function loadConfig(kbRoot: string): Promise<KBConfig> {
  let base: KBConfig = { ...DEFAULTS };

  const path = configPath(kbRoot);
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.indexModel) base.indexModel = parsed.indexModel;
      if (parsed.queryModel) base.queryModel = parsed.queryModel;
    } catch {
      // Ignore malformed config — fall back to defaults
    }
  }

  if (process.env.LLM_KB_INDEX_MODEL) base.indexModel = process.env.LLM_KB_INDEX_MODEL;
  if (process.env.LLM_KB_QUERY_MODEL) base.queryModel = process.env.LLM_KB_QUERY_MODEL;

  return base;
}

/**
 * Create .llm-kb/config.json with defaults if it doesn't exist yet.
 */
export async function ensureConfig(kbRoot: string): Promise<KBConfig> {
  const path = configPath(kbRoot);

  if (!existsSync(path)) {
    await mkdir(join(kbRoot, ".llm-kb"), { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
    return { ...DEFAULTS };
  }

  return loadConfig(kbRoot);
}
