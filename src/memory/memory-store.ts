import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { MemoryNotFoundError, StoreOpenError } from "../domain/errors.ts";
import { Memory, MemoryFact, UserId, type RecalledMemory, type RememberResult } from "../domain/schemas.ts";
import { resolveDbPath } from "../store/sqlite-ops-store.ts";
import { dot, EMBEDDING_DIMENSIONS, type Embedder } from "./embeddings.ts";

/** At most this many facts reach the agent per request. */
export const RECALL_LIMIT = 3;
/** A fact is recalled when it scores at least this much against the query. */
export const RECALL_MIN_SCORE = 0.3;
/** A new fact scoring above this against an existing one is a duplicate. */
export const DUPLICATE_THRESHOLD = 0.92;
/** forgetClosest removes a fact only when it scores at least this much against the description. */
export const FORGET_MIN_SCORE = 0.5;

/** Lasting facts per user, matched by meaning. Services and tools depend on this, never on SQL. */
export interface MemoryStore {
  /** Embeds the fact; returns the existing memory when one scores above 0.92, else stores it. */
  remember(userId: string, fact: string): Promise<RememberResult>;
  /** The user's memories scoring at least 0.3 against the query, best first, at most 3. */
  recall(userId: string, query: string): Promise<RecalledMemory[]>;
  /** Removes the user's memory with this id. Throws MemoryNotFoundError when there is none. */
  forget(userId: string, id: number): void;
  /**
   * Removes the user's single memory closest to the description when it scores at least 0.5 (newest
   * first on a tie) and returns it, without its score. Returns undefined and removes nothing when no
   * memory scores that much.
   */
  forgetClosest(userId: string, description: string): Promise<Memory | undefined>;
}

/** A memory with its embedding, as the store keeps it. */
export interface EmbeddedMemory extends Memory {
  embedding: Float32Array;
}

/** Pure: the bytes of a vector, for the BLOB column. */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Pure: a vector back from BLOB bytes. The bytes are copied first, because a BLOB's byteOffset is
 * not always a multiple of 4, and a Float32Array view on it would throw.
 */
export function fromBlob(bytes: Uint8Array): Float32Array {
  return new Float32Array(Uint8Array.from(bytes).buffer);
}

/** Pure: each memory with its similarity to the vector. The embedding is dropped. */
export function scoreRows(vector: Float32Array, rows: readonly EmbeddedMemory[]): RecalledMemory[] {
  return rows.map(({ embedding, ...memory }) => ({ ...memory, score: dot(vector, embedding) }));
}

/** Pure: best first (newest first on a tie), cut at `limit`, then only those scoring at least `minScore`. */
export function rankMemories(
  scored: readonly RecalledMemory[],
  { limit, minScore }: { limit: number; minScore: number },
): RecalledMemory[] {
  return [...scored]
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit)
    .filter((memory) => memory.score >= minScore);
}

/** Pure: the closest memory when it scores at least `minScore` (newest first on a tie). */
export function findClosest(scored: readonly RecalledMemory[], minScore: number): RecalledMemory | undefined {
  return rankMemories(scored, { limit: 1, minScore })[0];
}

/** Pure: the closest memory when it scores above `threshold` (exactly the threshold is not a duplicate). */
export function findDuplicate(scored: readonly RecalledMemory[], threshold: number): RecalledMemory | undefined {
  const [closest] = rankMemories(scored, { limit: 1, minScore: -Infinity });
  return closest && closest.score > threshold ? closest : undefined;
}

/** A recalled memory without its score, as remember reports an existing duplicate. */
export const withoutScore = ({ score: _score, ...memory }: RecalledMemory): Memory => memory;

/** The byte length of one embedding: 384 Float32 values. */
const EMBEDDING_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

/**
 * The length CHECKs are literal text on purpose: they are the second line of defence, so they must
 * not move with the zod schemas. A parity test keeps the two in step.
 */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  fact TEXT NOT NULL CHECK (length(fact) BETWEEN 1 AND 500),
  embedding BLOB NOT NULL CHECK (length(embedding) = 1536),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memories_by_user ON memories (user_id, id);
`;

// Every row is parsed, so a row edited by hand fails loudly.
const Row = z.object({
  id: z.number(),
  user_id: z.string(),
  fact: z.string(),
  embedding: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength === EMBEDDING_BYTES),
  created_at: z.string(),
});

const toEmbeddedMemory = (row: unknown): EmbeddedMemory => {
  const parsed = Row.parse(row);
  return {
    ...Memory.parse({ id: parsed.id, userId: parsed.user_id, fact: parsed.fact, createdAt: parsed.created_at }),
    embedding: fromBlob(parsed.embedding),
  };
};

export interface MemoryStoreOptions {
  embedder: Embedder;
  now?: () => string;
}

/** SQLite behind `MemoryStore`. Every value goes through a prepared statement; `exec` only sees constant text. */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly embedder: Embedder;
  private readonly now: () => string;

  private readonly insertMemory: StatementSync;
  private readonly selectByUser: StatementSync;
  private readonly deleteOne: StatementSync;

  constructor(path: string, options: MemoryStoreOptions) {
    this.embedder = options.embedder;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec(MEMORY_SCHEMA);
      this.insertMemory = this.db.prepare(
        "INSERT INTO memories (user_id, fact, embedding, created_at) VALUES (?, ?, ?, ?)",
      );
      this.selectByUser = this.db.prepare(
        "SELECT id, user_id, fact, embedding, created_at FROM memories WHERE user_id = ? ORDER BY id",
      );
      // The user_id condition is what keeps one user from removing another's memory.
      this.deleteOne = this.db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  async remember(userId: string, fact: string): Promise<RememberResult> {
    const user = UserId.parse(userId);
    const text = MemoryFact.parse(fact);
    const embedding = await this.embedder.embed(text);
    // No await from here on: DatabaseSync is synchronous, so the scan and the insert run as one step
    // and two near-duplicate remembers in this process cannot both miss each other.
    const duplicate = findDuplicate(scoreRows(embedding, this.allOf(user)), DUPLICATE_THRESHOLD);
    if (duplicate) return { memory: withoutScore(duplicate), created: false };
    const createdAt = this.now();
    const { lastInsertRowid } = this.insertMemory.run(user, text, toBlob(embedding), createdAt);
    return { memory: { id: Number(lastInsertRowid), userId: user, fact: text, createdAt }, created: true };
  }

  async recall(userId: string, query: string): Promise<RecalledMemory[]> {
    const user = UserId.parse(userId);
    const vector = await this.embedder.embed(query);
    return rankMemories(scoreRows(vector, this.allOf(user)), { limit: RECALL_LIMIT, minScore: RECALL_MIN_SCORE });
  }

  forget(userId: string, id: number): void {
    const user = UserId.parse(userId);
    if (this.deleteOne.run(id, user).changes !== 1) throw new MemoryNotFoundError(id);
  }

  async forgetClosest(userId: string, description: string): Promise<Memory | undefined> {
    const user = UserId.parse(userId);
    const text = MemoryFact.parse(description);
    const vector = await this.embedder.embed(text);
    // No await from here on, as in remember: the scan and the delete run as one step.
    const closest = findClosest(scoreRows(vector, this.allOf(user)), FORGET_MIN_SCORE);
    if (!closest) return undefined;
    this.deleteOne.run(closest.id, user);
    return withoutScore(closest);
  }

  private allOf(userId: string): EmbeddedMemory[] {
    return this.selectByUser.all(userId).map(toEmbeddedMemory);
  }
}

/** Creates the directory if needed and opens the store. Any failure becomes a `StoreOpenError` naming the path. */
export function openMemoryStore(env: NodeJS.ProcessEnv = process.env, options: MemoryStoreOptions): SqliteMemoryStore {
  const path = resolveDbPath(env);
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    return new SqliteMemoryStore(path, options);
  } catch (error) {
    throw new StoreOpenError(path, error instanceof Error ? error.message : String(error));
  }
}
