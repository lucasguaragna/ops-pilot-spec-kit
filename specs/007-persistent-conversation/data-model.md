# Data Model: Persistent Conversation

## Domain types (`src/domain/schemas.ts`)

| Type | Fields | Rules |
| --- | --- | --- |
| `MessageRole` | `"user" \| "assistant"` | Closed set. In spec terms, `user` is the engineer and `assistant` is the copilot (FR-014). |
| `Conversation` | `id: string`, `createdAt: string` | `id` is a UUID; `createdAt` is an ISO 8601 timestamp |
| `NewMessage` | `role: MessageRole`, `content: string` | What a caller appends |
| `StoredMessage` | `NewMessage` + `id: number`, `conversationId: string`, `createdAt: string` | `id` sets the order inside the conversation |

Rows read from SQLite are parsed with these zod schemas, as `toAlert` and the other row mappers do.

## Tables (`CONVERSATION_SCHEMA` in `src/store/sqlite-conversation-store.ts`)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id);
```

- The `role` CHECK is literal text that mirrors `MessageRole`. A parity test keeps the two in step,
  as for tier, severity, and status.
- `content` has no length CHECK: the user's text is already non-empty after zod, and a completed
  answer may legitimately be an empty string.
- Every statement is prepared once in the constructor. The DDL is idempotent, so opening an
  existing file is safe.

## Relationships

- One `Conversation` has zero or more `Message`s. A message belongs to exactly one conversation
  (foreign key, with `PRAGMA foreign_keys = ON`).
- Conversations and messages are never updated or deleted in this feature.

## Lifecycle of a request

```text
request ─► strategy found? ── no ──► 422 (nothing written)
              │ yes
              ▼
        conversationId? ── no ──► create()            ─┐
              │ yes                                    │
              ▼                                        │
        lastMessages(id, 12) ── unknown ──► 404        │
              │                                        │
              ▼◄───────────────────────────────────────┘
        run withHistory(strategy, history)
              │
              ├── completed  ──► append(user), append(assistant) ─► 200
              ├── iteration_limit ─► nothing saved ─► 200 (answer null)
              ├── error / thrown  ─► nothing saved ─► 502
              └── timeout         ─► nothing saved ─► 504
```

Every 200, 502, and 504 reply carries `conversationId`. Every reply that has `metrics` carries
`metrics.historyMessages` (from 0 to 12).
