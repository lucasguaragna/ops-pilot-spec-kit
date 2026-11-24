# Contract: MemoryStore

Location: `src/memory/memory-store.ts`. Services and tools depend on this interface, never on SQL.

```ts
interface MemoryStore {
  /** Embeds the fact; returns the existing memory when one scores above 0.92, else stores it. */
  remember(userId: string, fact: string): Promise<RememberResult>;
  /** The user's memories scoring at least 0.3 against the query, best first, at most 3. */
  recall(userId: string, query: string): Promise<RecalledMemory[]>;
  /** Removes the user's memory with this id. Throws MemoryNotFoundError when there is none. */
  forget(userId: string, id: number): void;
}

interface Embedder {
  /** A unit-length vector of EMBEDDING_DIMENSIONS values. Throws EmbeddingError on failure. */
  embed(text: string): Promise<Float32Array>;
}
```

Implementations:

- `SqliteMemoryStore(path, { embedder, now? })` and `openMemoryStore(env?, { embedder, now? })`,
  which creates the directory and wraps failures in `StoreOpenError`, like `openConversationStore`.
- `FakeMemoryStore({ embedder, now? })` in `src/testing/fake-memory-store.ts`, array-backed, never
  wired into `src/index.ts`. It reuses the same pure `rankMemories` and `findDuplicate`.

Pure helpers exported from `memory-store.ts` (and `dot` from `embeddings.ts`):

| Function | Behaviour |
| --- | --- |
| `dot(a, b)` | Sum of products. Throws when the lengths differ. |
| `scoreRows(vector, rows)` | Each row as a `RecalledMemory` with `score = dot(vector, row.embedding)`; the embedding is dropped. |
| `rankMemories(scored, { limit, minScore })` | Keep `score >= minScore`, sort by score desc then id desc, take `limit`. Works on scores only, so boundaries are tested with literal numbers. |
| `findDuplicate(scored, threshold)` | The highest-scoring item when its score is `> threshold`, else `undefined`. |
| `toBlob(vector)` / `fromBlob(bytes)` | Float32Array to BLOB bytes and back, copying (research R5). |

## Shared contract suite

`src/memory/memory-store-contract.ts` (not a `*.test.ts` file), run by the SQLite test on
`":memory:"` and by the fake test. Every case uses `FakeEmbedder`.

1. `remember` stores a fact and returns `{ created: true }` with id, user, trimmed fact, time.
2. `remember` of a text scoring above 0.92 against an existing fact returns that memory with
   `created: false` and stores nothing.
3. `remember` of a text scoring 0.9 against an existing fact stores a second memory.
4. The same fact for two users is stored twice (dedup never crosses users).
5. `recall` returns at most 3, best first, each with its score.
6. `recall` leaves out a memory scoring 0.25 and keeps one scoring 0.35.
7. `recall` orders equal scores newest first.
8. `recall` for a user with no memories returns `[]`.
9. `recall` never returns another user's memories.
10. `forget` removes the memory; a later `recall` does not return it.
11. `forget` of an unknown id, and of another user's id, throws `MemoryNotFoundError` carrying the
    id and leaves every memory in place.
12. `remember` rejects an empty or whitespace-only fact and a fact over 500 characters, storing
    nothing.
13. A fact with quotes and SQL-like text is stored and returned verbatim.

SQLite-only tests: restart on a temp file returns the same memories with the same scores; the CHECK
rejects a 1535-byte embedding and an empty user id when inserted with raw SQL; the CHECK limits
match `UserId` and `MemoryFact`.

## Real-model test

`src/memory/embeddings.test.ts`, with `localEmbedder` (research R4, R10):

- the vector has 384 values and unit length (within 1e-4)
- two calls share one pipeline load (the loader is called once)
- "who should I page about failed purchases?" recalls "The payments team owns the checkout
  service" and not "my favourite colour is green" (SC-001)
- "keep replies brief, please" recalls "I prefer answers in short bullet lists" first
