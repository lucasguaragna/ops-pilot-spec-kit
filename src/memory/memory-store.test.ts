import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { MemoryFact, UserId, type RecalledMemory } from "../domain/schemas.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { dot, EMBEDDING_DIMENSIONS } from "./embeddings.ts";
import { runMemoryStoreContract } from "./memory-store-contract.ts";
import { findDuplicate, fromBlob, MEMORY_SCHEMA, rankMemories, scoreRows, SqliteMemoryStore, toBlob } from "./memory-store.ts";

describe("dot", () => {
  it("is 1 for a unit vector with itself and 0 for two orthogonal axes", () => {
    const x = unitVector({ 0: 1 });
    assert.ok(Math.abs(dot(x, x) - 1) < 1e-6);
    assert.equal(dot(x, unitVector({ 1: 1 })), 0);
  });

  it("throws when the lengths differ", () => {
    assert.throws(() => dot(new Float32Array(2), new Float32Array(3)), /lengths differ/);
  });
});

describe("toBlob / fromBlob", () => {
  it("turns a 384-value vector into 1536 bytes", () => {
    assert.equal(toBlob(unitVector({ 0: 1 })).byteLength, 1536);
  });

  it("round-trips exactly, even from bytes at an odd offset", () => {
    const vector = unitVector({ 0: 0.3, 5: 0.4, 383: 0.5 });
    const bytes = toBlob(vector);
    const shifted = new Uint8Array(bytes.byteLength + 1);
    shifted.set(bytes, 1);
    assert.deepEqual(fromBlob(shifted.subarray(1)), vector);
  });
});

describe("scoreRows", () => {
  it("scores every row and drops the embedding", () => {
    const [scored] = scoreRows(unitVector({ 0: 1 }), [
      { id: 1, userId: "u", fact: "f", createdAt: "t", embedding: unitVector({ 0: 1 }) },
    ]);
    assert.equal(Object.hasOwn(scored!, "embedding"), false);
    assert.ok(Math.abs(scored!.score - 1) < 1e-6);
  });
});

describe("rankMemories", () => {
  const scored = (id: number, score: number): RecalledMemory => ({
    id,
    userId: "u",
    fact: `f${id}`,
    createdAt: "t",
    score,
  });
  const rank = (items: RecalledMemory[]) => rankMemories(items, { limit: 3, minScore: 0.3 }).map(({ id }) => id);

  it("keeps a score of exactly 0.3 and drops 0.2999", () => {
    assert.deepEqual(rank([scored(1, 0.2999), scored(2, 0.3)]), [2]);
  });

  it("returns at most 3, best first", () => {
    assert.deepEqual(rank([scored(1, 0.5), scored(2, 0.9), scored(3, 0.4), scored(4, 0.8), scored(5, 0.7)]), [2, 4, 5]);
  });

  it("orders equal scores newest first (higher id)", () => {
    assert.deepEqual(rank([scored(1, 0.5), scored(7, 0.5), scored(3, 0.5)]), [7, 3, 1]);
  });

  it("returns nothing for no memories", () => {
    assert.deepEqual(rank([]), []);
  });

  it("does not change its input", () => {
    const items = [scored(1, 0.4), scored(2, 0.9)];
    rank(items);
    assert.deepEqual(items.map(({ id }) => id), [1, 2]);
  });
});

describe("findDuplicate", () => {
  const scored = (id: number, score: number): RecalledMemory => ({ id, userId: "u", fact: `f${id}`, createdAt: "t", score });

  it("treats exactly 0.92 as not a duplicate and 0.9200001 as one", () => {
    assert.equal(findDuplicate([scored(1, 0.92)], 0.92), undefined);
    assert.equal(findDuplicate([scored(1, 0.9200001)], 0.92)?.id, 1);
  });

  it("returns the closest one when several are above the threshold", () => {
    assert.equal(findDuplicate([scored(1, 0.93), scored(2, 0.99), scored(3, 0.95)], 0.92)?.id, 2);
  });

  it("returns undefined for no memories", () => {
    assert.equal(findDuplicate([], 0.92), undefined);
  });
});

runMemoryStoreContract("sqlite :memory:", (options) => new SqliteMemoryStore(":memory:", options));

describe("SqliteMemoryStore: restart", () => {
  const vectors = {
    query: unitVector({ 0: 1 }),
    "The payments team owns the checkout service": scoredAgainst(0, 0.8, 10),
    "I prefer answers in short bullet lists": scoredAgainst(0, 0.5, 11),
  };
  let dir: string | undefined;
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("recalls the same memories with the same scores after reopening the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "opspilot-memories-"));
    const path = join(dir, "opspilot.db");
    const first = new SqliteMemoryStore(path, { embedder: new FakeEmbedder(vectors) });
    await first.remember("oncall-a", "The payments team owns the checkout service");
    await first.remember("oncall-a", "I prefer answers in short bullet lists");
    const before = await first.recall("oncall-a", "query");
    first.close();

    // Opening twice is safe: the schema is idempotent.
    new SqliteMemoryStore(path, { embedder: new FakeEmbedder(vectors) }).close();
    const reopened = new SqliteMemoryStore(path, { embedder: new FakeEmbedder(vectors) });
    try {
      assert.equal(before.length, 2);
      assert.deepEqual(await reopened.recall("oncall-a", "query"), before);
    } finally {
      reopened.close();
    }
  });
});

describe("memories table CHECKs", () => {
  const insert = (userId: string, fact: string, bytes: number) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(MEMORY_SCHEMA);
      db.prepare("INSERT INTO memories (user_id, fact, embedding, created_at) VALUES (?, ?, ?, ?)").run(
        userId,
        fact,
        new Uint8Array(bytes),
        "2026-11-20T12:00:00.000Z",
      );
    } finally {
      db.close();
    }
  };

  it("accepts a valid row", () => {
    assert.doesNotThrow(() => insert("oncall-a", "a fact", 1536));
  });

  it("rejects a 1535-byte embedding, an empty or 129-character user id, and a 501-character fact", () => {
    assert.throws(() => insert("oncall-a", "a fact", 1535), /CHECK constraint failed/);
    assert.throws(() => insert("", "a fact", 1536), /CHECK constraint failed/);
    assert.throws(() => insert("x".repeat(129), "a fact", 1536), /CHECK constraint failed/);
    assert.throws(() => insert("oncall-a", "x".repeat(501), 1536), /CHECK constraint failed/);
  });

  it("uses the same limits as UserId and MemoryFact", () => {
    const limits = (column: string) => {
      const match = new RegExp(`length\\(${column}\\) BETWEEN (\\d+) AND (\\d+)`).exec(MEMORY_SCHEMA);
      assert.ok(match, `no length CHECK on ${column}`);
      return [Number(match[1]), Number(match[2])] as const;
    };
    for (const [column, schema] of [["user_id", UserId], ["fact", MemoryFact]] as const) {
      const [min, max] = limits(column);
      assert.ok(schema.safeParse("x".repeat(min)).success && !schema.safeParse("x".repeat(min - 1)).success, column);
      assert.ok(schema.safeParse("x".repeat(max)).success && !schema.safeParse("x".repeat(max + 1)).success, column);
    }
    assert.match(MEMORY_SCHEMA, new RegExp(`length\\(embedding\\) = ${EMBEDDING_DIMENSIONS * 4}`));
  });
});
