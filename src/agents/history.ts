import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";

/** How many earlier messages (not exchanges) reach the agent: the last 6 question-and-answer pairs. */
export const HISTORY_LIMIT = 12;

/**
 * Pure: turns the earlier messages and the new message into the one string a strategy takes as input.
 * An empty history returns the message unchanged, so a first message behaves exactly as before.
 */
export function composeInput(history: readonly NewMessage[], message: string): string {
  if (history.length === 0) return message;
  const conversation = history
    .map(({ role, content }) => `${role === "user" ? "User" : "Assistant"}: ${content}`)
    .join("\n");
  return `Conversation so far (oldest first):\n${conversation}\n\nCurrent request: ${message}`;
}

/**
 * Wraps any strategy so it sees the history ahead of the new message, the same way `withReflection`
 * wraps one. Wrapping on the outside means the critic in reflection sees the earlier turns too.
 */
export function withHistory(strategy: ReasoningStrategy, history: readonly NewMessage[]): ReasoningStrategy {
  return {
    name: strategy.name,
    run: (input, options) => strategy.run(composeInput(history, input), options),
  };
}
