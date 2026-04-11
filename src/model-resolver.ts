import { getModels, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

export type ModelPurpose = "index" | "query" | "wiki" | "eval" | "generic";

/**
 * Map from Anthropic model IDs to OpenRouter equivalents.
 */
const ANTHROPIC_TO_OPENROUTER: Record<string, string> = {
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "claude-sonnet-4-0": "anthropic/claude-sonnet-4",
  "claude-opus-4-5": "anthropic/claude-opus-4.5",
};

const OPENROUTER_TO_ANTHROPIC = Object.fromEntries(
  Object.entries(ANTHROPIC_TO_OPENROUTER).map(([anthropic, openrouter]) => [openrouter, anthropic])
) as Record<string, string>;

const PURPOSE_FALLBACKS: Record<ModelPurpose, string[]> = {
  index: ["claude-haiku-4-5", "anthropic/claude-haiku-4.5", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
  query: ["claude-sonnet-4-6", "anthropic/claude-sonnet-4.6", "claude-sonnet-4-5", "anthropic/claude-sonnet-4.5"],
  wiki: ["claude-haiku-4-5", "anthropic/claude-haiku-4.5", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
  eval: ["claude-haiku-4-5", "anthropic/claude-haiku-4.5", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
  generic: ["claude-haiku-4-5", "anthropic/claude-haiku-4.5", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
};

/** Providers to try, in priority order for API-key-only uses */
const PROVIDERS = ["anthropic", "openrouter", "openai"] as const;

type Provider = (typeof PROVIDERS)[number];

function stripOpenAI(prefixOrId: string): string {
  return prefixOrId.replace(/^openai\//, "");
}

function modelCandidates(modelId: string, purpose: ModelPurpose): string[] {
  const ids = new Set<string>();
  ids.add(modelId);

  const mappedOpenRouter = ANTHROPIC_TO_OPENROUTER[modelId];
  if (mappedOpenRouter) ids.add(mappedOpenRouter);

  const mappedAnthropic = OPENROUTER_TO_ANTHROPIC[modelId];
  if (mappedAnthropic) ids.add(mappedAnthropic);

  if (modelId.startsWith("openai/")) ids.add(stripOpenAI(modelId));
  else ids.add(`openai/${modelId}`);

  for (const fallback of PURPOSE_FALLBACKS[purpose]) ids.add(fallback);
  return [...ids];
}

function providerOrder(modelId: string): Provider[] {
  if (modelId.startsWith("openai/") || modelId.startsWith("gpt-")) {
    return ["openai", "openrouter", "anthropic"];
  }
  if (modelId.startsWith("anthropic/") || modelId.startsWith("claude-")) {
    return ["anthropic", "openai", "openrouter"];
  }
  return ["openai", "openrouter", "anthropic"];
}

function resolveIdForProvider(provider: Provider, candidateId: string): string[] {
  switch (provider) {
    case "anthropic": {
      const ids = [candidateId];
      const mapped = OPENROUTER_TO_ANTHROPIC[candidateId];
      if (mapped) ids.push(mapped);
      return [...new Set(ids.filter((id) => !id.startsWith("openai/")))];
    }
    case "openrouter": {
      const ids = [candidateId];
      const mapped = ANTHROPIC_TO_OPENROUTER[candidateId];
      if (mapped) ids.unshift(mapped);
      if (candidateId.startsWith("gpt-")) ids.unshift(`openai/${candidateId}`);
      return [...new Set(ids)];
    }
    case "openai": {
      return [stripOpenAI(candidateId)].filter((id) => !id.startsWith("claude-") && !id.startsWith("anthropic/"));
    }
  }
}

async function findModelForProvider(
  provider: Provider,
  candidateId: string,
  storage: AuthStorage
): Promise<Model<any> | undefined> {
  const key = await storage.getApiKey(provider);
  if (!key) return undefined;

  const available = getModels(provider);
  for (const id of resolveIdForProvider(provider, candidateId)) {
    const model = available.find((m) => m.id === id);
    if (model) return model;
  }
  return undefined;
}

export interface ResolvedModelCandidate {
  provider: string;
  candidateId: string;
  model: Model<any>;
}

/**
 * Resolve all usable models in fallback order.
 */
export async function resolveModelCandidates(
  modelId: string,
  authStorage?: AuthStorage,
  purpose: ModelPurpose = "generic"
): Promise<ResolvedModelCandidate[]> {
  const storage = authStorage ?? AuthStorage.create();
  const resolved: ResolvedModelCandidate[] = [];
  const seen = new Set<string>();

  for (const candidateId of modelCandidates(modelId, purpose)) {
    for (const provider of providerOrder(candidateId)) {
      const model = await findModelForProvider(provider, candidateId, storage);
      if (!model) continue;
      const key = `${provider}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ provider, candidateId, model });
    }
  }

  return resolved;
}

/**
 * Resolve a model by ID, then fall back intelligently across providers.
 */
export async function resolveModel(
  modelId: string,
  authStorage?: AuthStorage,
  purpose: ModelPurpose = "generic"
): Promise<Model<any> | undefined> {
  const candidates = await resolveModelCandidates(modelId, authStorage, purpose);
  return candidates[0]?.model;
}

export async function getApiKeyForProvider(
  provider: string,
  authStorage?: AuthStorage
): Promise<string | undefined> {
  const storage = authStorage ?? AuthStorage.create();
  return storage.getApiKey(provider);
}

/**
 * Get an API key from whichever provider is available.
 */
export async function resolveApiKey(
  authStorage?: AuthStorage
): Promise<{ key: string; provider: string } | undefined> {
  const storage = authStorage ?? AuthStorage.create();

  for (const provider of PROVIDERS) {
    const key = await storage.getApiKey(provider);
    if (key) return { key, provider };
  }

  return undefined;
}
