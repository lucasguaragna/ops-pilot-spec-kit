import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { ConfigurationError } from "../domain/errors.ts";
import { createResilientModel } from "./resilient-model.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const ModelSettings = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  OPENROUTER_MODEL: z.string().trim().min(1),
  /** Optional: the model a call goes to once the primary is out of attempts. */
  OPENROUTER_MODEL_FALLBACK: z.string().trim().optional(),
});
type ModelSettings = z.infer<typeof ModelSettings>;

/** The fallback model name, or undefined when it is unset, blank, or the same as the primary. */
export function fallbackModelOf(settings: Pick<ModelSettings, "OPENROUTER_MODEL" | "OPENROUTER_MODEL_FALLBACK">): string | undefined {
  const fallback = settings.OPENROUTER_MODEL_FALLBACK;
  return fallback === undefined || fallback === "" || fallback === settings.OPENROUTER_MODEL ? undefined : fallback;
}

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

/**
 * One OpenRouter chat model. The client's own retries are off (`maxRetries: 0`): the resilient
 * model retries each call, so both would multiply the attempts.
 */
export function chatModelFor(settings: Pick<ModelSettings, "OPENROUTER_API_KEY">, model: string): ChatOpenAI {
  return new ChatOpenAI({
    model,
    apiKey: settings.OPENROUTER_API_KEY,
    configuration: { baseURL: OPENROUTER_BASE_URL },
    temperature: 0,
    maxRetries: 0,
    // Route only to models that honor every request parameter, such as a forced tool call.
    // Without it, routers like openrouter/free may pick a model that answers in plain text.
    modelKwargs: { provider: { require_parameters: true } },
  });
}

/**
 * The single model factory. Reads settings when called, so importing it never fails. Each call
 * retries on the primary, then goes to `OPENROUTER_MODEL_FALLBACK` when one is set.
 */
export function createModel(env: Record<string, string | undefined> = process.env): BaseChatModel {
  const settings = ModelSettings.safeParse(env);
  if (!settings.success) {
    throw new ConfigurationError(settings.error.issues.map((issue) => issue.path.join(".")));
  }
  const fallbackName = fallbackModelOf(settings.data);
  return createResilientModel({
    primary: { model: chatModelFor(settings.data, settings.data.OPENROUTER_MODEL), name: settings.data.OPENROUTER_MODEL },
    fallback:
      fallbackName === undefined ? undefined : { model: chatModelFor(settings.data, fallbackName), name: fallbackName },
  });
}
