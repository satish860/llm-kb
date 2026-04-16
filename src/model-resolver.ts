import { type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

/**
 * Resolve a model by ID, mapping to the local Ollama instance.
 */
export async function resolveModel(
  modelId: string,
  authStorage?: AuthStorage
): Promise<Model<any> | undefined> {
  const id = modelId || "llama3";
  return {
    id,
    name: `Ollama (${id})`,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      requiresToolResultName: false,
      supportsDeveloperRole: false,
      supportsStore: false
    }
  };
}

/**
 * Dummy API key resolver for Ollama to bypass auth.
 */
export async function resolveApiKey(
  authStorage?: AuthStorage
): Promise<{ key: string; provider: string } | undefined> {
  return { key: "ollama", provider: "ollama" };
}
