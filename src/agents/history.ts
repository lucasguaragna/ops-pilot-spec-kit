import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";
import { carrySystemPrompt } from "./system-prompt.ts";

/** How many earlier messages (not exchanges) reach the agent: the last 6 question-and-answer pairs. */
export const HISTORY_LIMIT = 12;

/**
 * Pure: everything `composeInput` puts ahead of the message: the labelled earlier messages and the
 * "Current request:" label. An empty history is "", so a first message behaves exactly as before.
 */
export function historyBlock(history: readonly NewMessage[]): string {
  if (history.length === 0) return "";
  const conversation = history
    .map(({ role, content }) => `${role === "user" ? "User" : "Assistant"}: ${content}`)
    .join("\n");
  return `Conversation so far (oldest first):\n${conversation}\n\nCurrent request: `;
}

/** Pure: turns the earlier messages and the new message into the one string a strategy takes as input. */
export function composeInput(history: readonly NewMessage[], message: string): string {
  return historyBlock(history) + message;
}

/**
 * Wraps any strategy so it sees the history ahead of the new message, the same way `withReflection`
 * wraps one. Wrapping on the outside means the critic in reflection sees the earlier turns too.
 */
export function withHistory(strategy: ReasoningStrategy, history: readonly NewMessage[]): ReasoningStrategy {
  return {
    name: strategy.name,
    ...carrySystemPrompt(strategy),
    run: (input, options) => strategy.run(composeInput(history, input), options),
  };
}
