import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { ResolvedModelCandidate } from "./model-resolver.js";

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

export interface RetryingSessionOptions {
  createSession: (candidate: ResolvedModelCandidate) => Promise<AgentSession>;
  candidates: ResolvedModelCandidate[];
  validatePromptResult?: (session: AgentSession, beforeMessageCount: number) => string | undefined;
  onRetry?: (info: {
    from: ResolvedModelCandidate;
    to: ResolvedModelCandidate;
    error: unknown;
    attempt: number;
  }) => void;
}

export async function createRetryingSession(options: RetryingSessionOptions): Promise<AgentSession> {
  const { createSession, candidates, validatePromptResult, onRetry } = options;
  if (candidates.length === 0) throw new Error("No usable models available");

  let candidateIndex = 0;
  let current = await createSession(candidates[candidateIndex]!);
  let sessionName: string | undefined;
  const subscribers: Array<(event: any) => void> = [];

  const attachSubscribers = (session: AgentSession) => {
    for (const sub of subscribers) session.subscribe(sub);
  };

  const swapTo = async (nextIndex: number) => {
    const prev = current;
    candidateIndex = nextIndex;
    current = await createSession(candidates[candidateIndex]!);
    if (sessionName) current.setSessionName(sessionName);
    attachSubscribers(current);
    prev.dispose();
  };

  const proxy = {
    get sessionId() {
      return current.sessionId;
    },
    get sessionFile() {
      return current.sessionFile;
    },
    get state() {
      return current.state;
    },
    subscribe(fn: (event: any) => void) {
      subscribers.push(fn);
      return current.subscribe(fn);
    },
    async prompt(text: string) {
      let lastError: unknown;
      for (let i = candidateIndex; i < candidates.length; i++) {
        if (i !== candidateIndex) await swapTo(i);
        const beforeMessageCount = Array.isArray((current as any).state?.messages)
          ? (current as any).state.messages.length
          : 0;
        try {
          const result = await current.prompt(text);
          const validationError = validatePromptResult?.(current, beforeMessageCount);
          if (!validationError) return result;

          const next = candidates[i + 1];
          const error = new Error(validationError);
          lastError = error;
          if (!next) throw error;
          onRetry?.({
            from: candidates[i]!,
            to: next,
            error,
            attempt: i + 2,
          });
          continue;
        } catch (error) {
          lastError = error;
          const next = candidates[i + 1];
          if (!next || !isRetryableProviderError(error)) throw error;
          onRetry?.({
            from: candidates[i]!,
            to: next,
            error,
            attempt: i + 2,
          });
        }
      }
      throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
    },
    async reload() {
      return current.reload();
    },
    setSessionName(name: string) {
      sessionName = name;
      return current.setSessionName(name);
    },
    dispose() {
      return current.dispose();
    },
  } satisfies Partial<AgentSession> & {
    sessionId: string;
    sessionFile?: string;
    state: any;
    subscribe: AgentSession["subscribe"];
    prompt: AgentSession["prompt"];
    reload: AgentSession["reload"];
    setSessionName: AgentSession["setSessionName"];
    dispose: AgentSession["dispose"];
  };

  return proxy as AgentSession;
}

export function describeModelCandidate(candidate: ResolvedModelCandidate): string {
  const provider = candidate.provider;
  const model = candidate.model;
  return `${provider}:${model.id}`;
}
