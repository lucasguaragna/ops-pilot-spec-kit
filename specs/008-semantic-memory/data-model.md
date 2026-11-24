# Data Model: Semantic Memory

## Domain types (`src/domain/schemas.ts`)

| Schema | Shape | Rules |
| --- | --- | --- |
| `UserId` | `string` | trimmed, 1 to 128 characters |
| `MemoryFact` | `string` | trimmed, 1 to 500 characters |
| `MemoryId` | `number` | positive integer |
| `Memory` | `{ id: MemoryId, userId: UserId, fact: MemoryFact, createdAt: string }` | `createdAt` is ISO 8601 |
| `RecalledMemory` | `Memory & { score: number }` | `score` in [-1, 1]; only built by `recall`, never stored |
| `RememberResult` | `{ memory: Memory, created: boolean }` | `created: false` means an existing duplicate was returned |

The embedding is not part of `Memory`: it never leaves the store, so tool output and the prompt stay
small.

## Constants (`src/memory/memory-store.ts`)

| Name | Value | Used by |
| --- | --- | --- |
| `EMBEDDING_DIMENSIONS` | 384 (in `embeddings.ts`) | the CHECK on `embedding`, `FakeEmbedder`, decoding |
| `DUPLICATE_THRESHOLD` | 0.92 | `findDuplicate`: duplicate when `score > 0.92` |
| `RECALL_MIN_SCORE` | 0.3 | `rankMemories`: kept when `score >= 0.3` |
| `RECALL_LIMIT` | 3 | `rankMemories`: at most 3 |

## Table `memories`

```sql
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  fact TEXT NOT NULL CHECK (length(fact) BETWEEN 1 AND 500),
  embedding BLOB NOT NULL CHECK (length(embedding) = 1536),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memories_by_user ON memories (user_id, id);
```

- Same file as the operations and conversation data (`OPSPILOT_DB`), opened by its own
  `DatabaseSync`, like `SqliteConversationStore`.
- `STRICT` makes SQLite reject a non-BLOB `embedding` and a non-text `fact`.
- 1536 = 384 Float32 values × 4 bytes (research R5).
- No foreign key: there is no users table; a user exists once they have a row.
- The `length` CHECKs mirror `UserId` and `MemoryFact`; a parity test keeps them in step.

## Prepared statements

| Statement | SQL |
| --- | --- |
| insert | `INSERT INTO memories (user_id, fact, embedding, created_at) VALUES (?, ?, ?, ?)` |
| select by user | `SELECT id, user_id, fact, embedding, created_at FROM memories WHERE user_id = ? ORDER BY id` |
| delete one | `DELETE FROM memories WHERE id = ? AND user_id = ?` (forgotten when `changes === 1`) |

## Lifecycle

```text
(nothing) --remember, no duplicate--> stored --forget--> (gone)
(nothing) --remember, duplicate of X--> X returned, nothing stored
```

A memory is never updated. Changing a fact is forget plus remember.

## Request and reply additions

- `ChatRequest.userId`: `UserId.optional()`.
- `MetricsSchema.recalledMemories`: integer 0 to 3, in the 200 reply and in a 502 reply that has
  partial metrics. HTTP-only, like `historyMessages`.
- `ChatOutcome` gains `recalledMemories: number`.
