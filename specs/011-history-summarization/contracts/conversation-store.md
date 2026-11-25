# Contract: `ConversationStore` additions

`src/store/conversation-store.ts` gains three methods, implemented by `SqliteConversationStore`
and `FakeConversationStore`. They are checked by `runConversationStoreContract`, which runs
against both.

```ts
interface ConversationStore {
  // existing: create, append, lastMessages

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
```

| Call | Result |
| --- | --- |
| `messagesAfter(id, 0)` on 5 messages | all 5, oldest first |
| `messagesAfter(id, 3)` on 5 messages | messages 4 and 5 |
| `messagesAfter(id, 9)` on 5 messages | `[]` |
| `messagesAfter(id, -1)` | throws (zod), never binds a negative offset |
| `summaryOf(id)` on a new conversation | `undefined` |
| `saveSummary(id, "- a", 0, 8)` with no summary | `true`; `summaryOf` returns the text with `coveredMessages: 8` |
| `saveSummary(id, "- b", 0, 8)` after the above | `false`; the stored summary is unchanged |
| `saveSummary(id, "- b", 8, 16)` | `true`; coverage 16 |
| `saveSummary(id, "- c", 8, 24)` after coverage moved to 16 | `false` (lost the compare-and-swap) |
| `saveSummary(id, "- a", 8, 8)` | throws: coverage must grow |
| `saveSummary(id, "   ", 0, 8)` | throws (zod): the summary is blank |
| any method with an unknown id | throws `ConversationNotFoundError` |

Persistence (SQLite only): a second `SqliteConversationStore` opened on the same temporary file
returns the same `summaryOf`. Opening a database created before this feature adds the table and
keeps every message.

The SQL lives behind this interface. The service never sees it.
