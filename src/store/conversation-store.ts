import { z } from "zod";
import {
  SummaryText,
  type Conversation,
  type ConversationSummary,
  type NewMessage,
  type StoredMessage,
} from "../domain/schemas.ts";

/** How many of the oldest messages a summary covers. A negative OFFSET would mean "none" in SQLite, so it is checked first. */
export const CoveredCount = z.number().int().nonnegative();

/**
 * Pure: the checks every store applies before it writes a summary. The text must not be blank, and
 * the coverage must grow (a summary never covers fewer messages than the one it replaces). Returns
 * the trimmed text.
 */
export function parseSummarySave(summary: string, expectedCovered: number, coveredMessages: number): string {
  const expected = CoveredCount.parse(expectedCovered);
  const covered = z.number().int().positive().parse(coveredMessages);
  if (covered <= expected) {
    throw new RangeError(`A summary must cover more than the ${expected} messages already covered, got ${covered}`);
  }
  return SummaryText.parse(summary);
}

/** Persistent chat history. Services depend on this interface, never on SQL. */
export interface ConversationStore {
  /** Creates an empty conversation with a new random id. */
  create(): Conversation;
  /** Appends at the end. Throws ConversationNotFoundError for an unknown id. */
  append(conversationId: string, message: NewMessage): StoredMessage;
  /** The newest `limit` messages, oldest first. Throws ConversationNotFoundError for an unknown id. */
  lastMessages(conversationId: string, limit: number): StoredMessage[];
  /** Every message after the first `covered`, oldest first. Throws ConversationNotFoundError for an unknown id. */
  messagesAfter(conversationId: string, covered: number): StoredMessage[];
  /** The stored summary, or undefined. Throws ConversationNotFoundError for an unknown id. */
  summaryOf(conversationId: string): ConversationSummary | undefined;
  /**
   * Stores `summary` as covering the first `coveredMessages` messages, only when the stored coverage
   * is still `expectedCovered` (0 = no summary yet). Returns whether it wrote. Throws
   * ConversationNotFoundError for an unknown id, and a zod error for a blank summary, or for a
   * `coveredMessages` that is not greater than `expectedCovered`.
   */
  saveSummary(conversationId: string, summary: string, expectedCovered: number, coveredMessages: number): boolean;
}
