import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import {
  getApiKeyForProvider,
  resolveModelCandidates,
  type ModelPurpose,
  type ResolvedModelCandidate,
} from "./model-resolver.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function isRetryableProviderError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return [
    "401",
    "403",
    "429",
    "quota",
    "credit",
    "rate limit",
    "overloaded",
    "overload",
    "unavailable",
    "timeout",
    "timed out",
    "network",
    "connection",
    "provider",
    "api key",
    "authentication",
    "unauthorized",
    "forbidden",
  ].some((term) => message.includes(term));
}

export async function completeWithFallback(
  modelId: string,
  authStorage: AuthStorage | undefined,
  purpose: ModelPurpose,
  input: Parameters<typeof completeSimple>[1]
) {
  const candidates = await resolveModelCandidates(modelId, authStorage, purpose);
  if (candidates.length === 0) {
    throw new Error(`No usable model found for '${modelId}'. Configure Anthropic, OpenRouter, or OpenAI credentials.`);
  }

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const apiKey = await getApiKeyForProvider(candidate.provider, authStorage);
    if (!apiKey) continue;

    try {
      return await completeSimple(candidate.model as Model<any>, input, { apiKey });
    } catch (error) {
      lastError = error;
      if (i === candidates.length - 1 || !isRetryableProviderError(error)) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}
