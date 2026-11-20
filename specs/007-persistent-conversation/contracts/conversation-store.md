# Contract: `ConversationStore` (`src/store/conversation-store.ts`)

```ts
export interface ConversationStore {
  /** Creates an empty conversation with a new random id. */
  create(): Conversation;
  /** Appends at the end. Throws ConversationNotFoundError for an unknown id. */
  append(conversationId: string, message: NewMessage): StoredMessage;
  /** The newest `limit` messages, oldest first. Throws ConversationNotFoundError for an unknown id. */
  lastMessages(conversationId: string, limit: number): StoredMessage[];
}
```

Implementations:

- `SqliteConversationStore(path, { now?, newId? })` with `close()`, plus
  `openConversationStore(env)`, which mirrors `openOpsStore` and throws `StoreOpenError`.
- `FakeConversationStore({ now?, newId? })` in `src/testing/`, for tests only.

## Behaviour every implementation shares (`runConversationStoreContract`)

1. `create()` returns a conversation whose `lastMessages(id, 12)` is `[]`.
2. Two `create()` calls return different ids.
3. `append` returns the stored message with its `conversationId`, `role`, `content`, and
   `createdAt` from `now`.
4. `lastMessages` returns the messages in the order they were appended.
5. With 20 messages, `lastMessages(id, 12)` returns messages 9 to 20, oldest first.
6. With 5 messages, `lastMessages(id, 12)` returns all 5.
7. `lastMessages(id, 0)` returns `[]`.
8. Messages from one conversation never appear in another.
9. `append` and `lastMessages` on an unknown id throw `ConversationNotFoundError` carrying the id.

## SQLite-only tests

- The `role` CHECK rejects a raw insert with any other role, and its list matches `MessageRole`
  (parity test).
- A raw insert into `messages` with an unknown `conversation_id` fails on the foreign key.
- Opening the store twice on the same database is idempotent.
- Restart: a file in a fresh OS temporary directory, write, close, reopen, read the same messages,
  then remove the directory (the constitution's persistence rules).
