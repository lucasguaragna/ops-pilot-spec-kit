import { randomUUID } from "node:crypto";
import { ConversationNotFoundError } from "../domain/errors.ts";
import type { Conversation, NewMessage, StoredMessage } from "../domain/schemas.ts";
import type { ConversationStore } from "../store/conversation-store.ts";

/** Map-backed ConversationStore for tests. It must never be wired into `src/index.ts`. */
export class FakeConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, StoredMessage[]>();
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

  private messagesOf(conversationId: string): StoredMessage[] {
    const messages = this.conversations.get(conversationId);
    if (!messages) throw new ConversationNotFoundError(conversationId);
    return messages;
  }
}
