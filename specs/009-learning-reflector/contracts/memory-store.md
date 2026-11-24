# Contract: MemoryStore changes

Extends [008 memory-store](../../008-semantic-memory/contracts/memory-store.md). `remember`,
`recall`, and `forget` are unchanged.

## New constant and pure helper (`src/memory/memory-store.ts`)

```ts
/** forgetClosest removes a memory only when it scores at least this much against the description. */
export const FORGET_MIN_SCORE = 0.5;

/** Pure: the single best memory scoring at least minScore (newest first on a tie), or undefined. */
export function findClosest(scored: readonly RecalledMemory[], minScore: number): RecalledMemory | undefined;
```

`findClosest` is `rankMemories(scored, { limit: 1, minScore })[0]`.

## New method

```ts
interface MemoryStore {
  /**
   * Removes the user's memory closest to the description when it scores at least 0.5, and returns
   * it without its score. Returns undefined and removes nothing when none does.
   */
  forgetClosest(userId: string, description: string): Promise<Memory | undefined>;
}
```

- Validates `userId` with `UserId` and `description` with `MemoryFact` (throws `ZodError`).
- Embeds the description first; then scans and deletes with no `await` in between.
- Deletes by `id` and `user_id` with the existing prepared `deleteOne` statement.
- An `EmbeddingError` propagates.

## Contract suite cases (both `SqliteMemoryStore` on `":memory:"` and `FakeMemoryStore`)

1. A description scoring exactly 0.5 removes the fact; 0.4999 removes nothing.
2. With several facts at or above 0.5, only the closest is removed; on a tie, the newest (higher id).
3. Another user's identical fact is never removed.
4. A user with no memories gets `undefined`.
5. The removed memory is no longer recalled; the others still are.
