import type { Conversation, NewMessage, StoredMessage } from "../domain/schemas.ts";

/** Persistent chat history. Services depend on this interface, never on SQL. */
export interface ConversationStore {
  /** Creates an empty conversation with a new random id. */
  create(): Conversation;
  /** Appends at the end. Throws ConversationNotFoundError for an unknown id. */
  append(conversationId: string, message: NewMessage): StoredMessage;
  /** The newest `limit` messages, oldest first. Throws ConversationNotFoundError for an unknown id. */
  lastMessages(conversationId: string, limit: number): StoredMessage[];
}
