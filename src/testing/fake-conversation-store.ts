import { randomUUID } from "node:crypto";
import { ConversationNotFoundError } from "../domain/errors.ts";
import type { Conversation, ConversationSummary, NewMessage, StoredMessage } from "../domain/schemas.ts";
import { CoveredCount, parseSummarySave, type ConversationStore } from "../store/conversation-store.ts";

/** Map-backed ConversationStore for tests. It must never be wired into `src/index.ts`. */
export class FakeConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, StoredMessage[]>();
  private readonly summaries = new Map<string, ConversationSummary>();
  private readonly now: () => string;
  private readonly newId: () => string;
  private nextMessageId = 1;

  constructor(options: { now?: () => string; newId?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  create(): Conversation {
    const id = this.newId();
    this.conversations.set(id, []);
    return { id, createdAt: this.now() };
  }

  append(conversationId: string, message: NewMessage): StoredMessage {
    const messages = this.messagesOf(conversationId);
    const stored: StoredMessage = {
      id: this.nextMessageId++,
      conversationId,
      role: message.role,
      content: message.content,
      createdAt: this.now(),
    };
    messages.push(stored);
    return stored;
  }

  lastMessages(conversationId: string, limit: number): StoredMessage[] {
    const messages = this.messagesOf(conversationId);
    return limit <= 0 ? [] : messages.slice(-limit);
  }

  messagesAfter(conversationId: string, covered: number): StoredMessage[] {
    const skip = CoveredCount.parse(covered);
    return this.messagesOf(conversationId).slice(skip);
  }

  summaryOf(conversationId: string): ConversationSummary | undefined {
    this.messagesOf(conversationId);
    const summary = this.summaries.get(conversationId);
    return summary && structuredClone(summary);
  }

  saveSummary(conversationId: string, summary: string, expectedCovered: number, coveredMessages: number): boolean {
    const text = parseSummarySave(summary, expectedCovered, coveredMessages);
    this.messagesOf(conversationId);
    const stored = this.summaries.get(conversationId)?.coveredMessages ?? 0;
    if (stored !== expectedCovered) return false;
    this.summaries.set(conversationId, { conversationId, summary: text, coveredMessages, updatedAt: this.now() });
    return true;
  }

  private messagesOf(conversationId: string): StoredMessage[] {
    const messages = this.conversations.get(conversationId);
    if (!messages) throw new ConversationNotFoundError(conversationId);
    return messages;
  }
}
