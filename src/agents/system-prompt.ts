import type { ReasoningStrategy } from "../domain/types.ts";

/**
 * What a wrapper copies from the strategy it wraps so the system prompt stays visible: the key only
 * when the wrapped strategy has one, never `systemPrompt: undefined`, so wrapped fakes stay equal.
 */
export function carrySystemPrompt(strategy: ReasoningStrategy): { systemPrompt?: string } {
  return strategy.systemPrompt === undefined ? {} : { systemPrompt: strategy.systemPrompt };
}
