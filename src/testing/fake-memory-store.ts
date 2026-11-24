import { MemoryNotFoundError } from "../domain/errors.ts";
import { MemoryFact, UserId, type RecalledMemory, type RememberResult } from "../domain/schemas.ts";
import type { Embedder } from "../memory/embeddings.ts";
import {
  DUPLICATE_THRESHOLD,
  findDuplicate,
  withoutScore,
  rankMemories,
  RECALL_LIMIT,
  RECALL_MIN_SCORE,
  scoreRows,
  type EmbeddedMemory,
  type MemoryStore,
  type MemoryStoreOptions,
} from "../memory/memory-store.ts";

/** Array-backed MemoryStore for tests. It must never be wired into `src/index.ts`. */
export class FakeMemoryStore implements MemoryStore {
  private readonly memories: EmbeddedMemory[] = [];
  private readonly embedder: Embedder;
  private readonly now: () => string;
  private nextId = 1;

  constructor(options: MemoryStoreOptions) {
    this.embedder = options.embedder;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async remember(userId: string, fact: string): Promise<RememberResult> {
    const user = UserId.parse(userId);
    const text = MemoryFact.parse(fact);
    const embedding = await this.embedder.embed(text);
    const duplicate = findDuplicate(scoreRows(embedding, this.allOf(user)), DUPLICATE_THRESHOLD);
    if (duplicate) return { memory: withoutScore(duplicate), created: false };
    const memory = { id: this.nextId++, userId: user, fact: text, createdAt: this.now() };
    this.memories.push({ ...memory, embedding });
    return { memory, created: true };
  }

  async recall(userId: string, query: string): Promise<RecalledMemory[]> {
    const user = UserId.parse(userId);
    const vector = await this.embedder.embed(query);
    return rankMemories(scoreRows(vector, this.allOf(user)), { limit: RECALL_LIMIT, minScore: RECALL_MIN_SCORE });
  }

  forget(userId: string, id: number): void {
    const user = UserId.parse(userId);
    const index = this.memories.findIndex((memory) => memory.id === id && memory.userId === user);
    if (index === -1) throw new MemoryNotFoundError(id);
    this.memories.splice(index, 1);
  }

  private allOf(userId: string): EmbeddedMemory[] {
    return this.memories.filter((memory) => memory.userId === userId);
  }
}
