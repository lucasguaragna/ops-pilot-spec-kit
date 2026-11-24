import type { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

/**
 * A rough token count: the text length divided by 4, rounded up (0 for an empty text). It is a
 * teaching baseline, not a tokenizer: `length` counts UTF-16 code units, so accented letters count
 * 1 and an emoji counts 2, and real tokenizers differ by language and content.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The input tokens a finished model call reported: the sum of `usage_metadata.input_tokens` over
 * the output's chat generations whose message carries a non-negative integer. undefined when none
 * does, so a provider that reports nothing is told apart from one that reported 0.
 */
export function promptTokensOf(output: LLMResult): number | undefined {
  let total: number | undefined;
  for (const generation of output.generations.flat()) {
    // Only chat generations carry a message, and only an AI message carries usage metadata.
    const message = (generation as Partial<ChatGeneration>).message as Partial<AIMessage> | undefined;
    const reported = message?.usage_metadata?.input_tokens;
    if (isTokenCount(reported)) total = (total ?? 0) + reported;
  }
  return total;
}

/** Adds a call's reported tokens to a run's total. The total is null until some call reports. */
export function addPromptTokens(total: number | null, more: number | null | undefined): number | null {
  if (more === null || more === undefined) return total;
  return (total ?? 0) + more;
}
