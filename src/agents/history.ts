import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";
import { carrySystemPrompt } from "./system-prompt.ts";

/** The newest messages the agent always gets word for word. */
export const HISTORY_WINDOW = 8;

/** Uncovered messages older than the window that make one summarization worth its model call. */
export const SUMMARY_BATCH = 8;

/**
 * The most messages the agent gets word for word: the window plus a batch, less one exchange. It also
 * holds after a failed summarization, so a provider outage cannot grow the context.
 */
export const MAX_VERBATIM = 14;

/** Cap on the rendered summary, measured with `estimateTokens`. */
export const SUMMARY_MAX_TOKENS = 300;

/**
 * Pure: which uncovered messages (those no summary stands for yet, oldest first) to summarize now,
 * and which go to the agent word for word.
 *
 * With `outside` the messages older than the window, a summarization is due only when `outside` has
 * just reached 8, 16, 24, and so on: `outside >= 8 && outside % 8 < 2`. `outside` grows by 2 per
 * exchange, so that happens once in every 4 exchanges, and a failed attempt waits for the next
 * boundary instead of being retried on the next request. When it is due, everything outside the
 * window is summarized, so a retry catches up. Otherwise nothing is summarized and the newest
 * `MAX_VERBATIM` messages are given as they are.
 */
export function planHistory(uncovered: readonly NewMessage[]): { toSummarize: NewMessage[]; verbatim: NewMessage[] } {
  const outside = uncovered.length - HISTORY_WINDOW;
  if (outside >= SUMMARY_BATCH && outside % SUMMARY_BATCH < 2) {
    return { toSummarize: uncovered.slice(0, outside), verbatim: uncovered.slice(outside) };
  }
  return { toSummarize: [], verbatim: uncovered.slice(-MAX_VERBATIM) };
}

/** Pure: the messages as `User: …` and `Assistant: …` lines, oldest first, one per line. */
export function messageLines(messages: readonly NewMessage[]): string {
  return messages.map(({ role, content }) => `${role === "user" ? "User" : "Assistant"}: ${content}`).join("\n");
}

/**
 * Pure: everything `composeInput` puts ahead of the message: the rendered summary (if any), then the
 * labelled earlier messages and the "Current request:" label. With no summary and no history it is
 * "", so a first message behaves exactly as before.
 */
export function historyBlock(history: readonly NewMessage[], summary = ""): string {
  if (history.length === 0) return summary;
  return `${summary}Conversation so far (oldest first):\n${messageLines(history)}\n\nCurrent request: `;
}

/** Pure: turns the summary, the earlier messages, and the new message into the one string a strategy takes as input. */
export function composeInput(history: readonly NewMessage[], message: string, summary = ""): string {
  return historyBlock(history, summary) + message;
}

/**
 * Wraps any strategy so it sees the summary and the history ahead of the new message, the same way
 * `withReflection` wraps one. Wrapping on the outside means the critic in reflection sees the earlier
 * turns too.
 */
export function withHistory(
  strategy: ReasoningStrategy,
  history: readonly NewMessage[],
  summary = "",
): ReasoningStrategy {
  return {
    name: strategy.name,
    ...carrySystemPrompt(strategy),
    run: (input, options) => strategy.run(composeInput(history, input, summary), options),
  };
}
