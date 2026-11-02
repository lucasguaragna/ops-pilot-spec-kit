import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { ConfigurationError } from "../domain/errors.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const ModelSettings = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  OPENROUTER_MODEL: z.string().trim().min(1),
});

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

/**
 * Decides whether a failed model call is retried: returning retries, throwing gives up. LangChain's
 * default gives up on a 429 without a retry-after header, which is what OpenRouter's free models
 * send when an upstream provider is busy, so those are retried with backoff here. A daily quota
 * and other client errors still fail at once.
 */
export function retryFailedCall(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(Cancel|AbortError)/.test(message) || (error instanceof Error && error.name === "AbortError")) throw error;
  const status = statusOf(error);
  if (status === 429) {
    if (/per-day|insufficient_quota/i.test(message)) throw error;
    return;
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) throw error;
}

/** The single model factory. Reads settings when called, so importing it never fails. */
export function createModel(env: Record<string, string | undefined> = process.env): ChatOpenAI {
  const settings = ModelSettings.safeParse(env);
  if (!settings.success) {
    throw new ConfigurationError(settings.error.issues.map((issue) => issue.path.join(".")));
  }
  return new ChatOpenAI({
    model: settings.data.OPENROUTER_MODEL,
    apiKey: settings.data.OPENROUTER_API_KEY,
    configuration: { baseURL: OPENROUTER_BASE_URL },
    temperature: 0,
    // Route only to models that honor every request parameter, such as a forced tool call.
    // Without it, routers like openrouter/free may pick a model that answers in plain text.
    modelKwargs: { provider: { require_parameters: true } },
    onFailedAttempt: retryFailedCall,
  });
}
