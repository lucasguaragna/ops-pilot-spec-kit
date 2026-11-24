import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryNotFoundError } from "../domain/errors.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import type { MemoryStore, MemoryStoreOptions } from "./memory-store.ts";

export const CONTRACT_NOW = "2026-11-20T12:00:00.000Z";

/** Every query in the contract is axis 0, so `scoredAgainst(0, s, k)` scores `s` against it. */
const QUERY = "query";

/**
 * Behaviour every MemoryStore must share. Not a *.test.ts file, so the runner only loads it through
 * the store test files that import it. Each case builds its own FakeEmbedder table, so the scores
 * are chosen on purpose.
 */
export function runMemoryStoreContract(label: string, makeStore: (options: MemoryStoreOptions) => MemoryStore): void {
  describe(`MemoryStore contract: ${label}`, () => {
    const fresh = (vectors: Record<string, Float32Array>) =>
      makeStore({ embedder: new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), ...vectors }), now: () => CONTRACT_NOW });

    describe("remember and recall", () => {
      it("stores a fact and returns it with its id, user, trimmed text, and time", async () => {
        const store = fresh({ "The payments team owns checkout": scoredAgainst(0, 0.8) });
        const { memory, created } = await store.remember("oncall-a", "  The payments team owns checkout  ");
        assert.equal(created, true);
        assert.ok(Number.isInteger(memory.id) && memory.id > 0);
        assert.equal(memory.userId, "oncall-a");
        assert.equal(memory.fact, "The payments team owns checkout");
        assert.equal(memory.createdAt, CONTRACT_NOW);
      });

      it("recalls at most 3, best first, each with its score", async () => {
        const store = fresh({
          a: scoredAgainst(0, 0.6, 10),
          b: scoredAgainst(0, 0.9, 11),
          c: scoredAgainst(0, 0.7, 12),
          d: scoredAgainst(0, 0.8, 13),
        });
        for (const fact of ["a", "b", "c", "d"]) await store.remember("oncall-a", fact);
        const recalled = await store.recall("oncall-a", QUERY);
        assert.deepEqual(recalled.map((memory) => memory.fact), ["b", "d", "c"]);
        for (const [memory, score] of recalled.map((memory, index) => [memory, [0.9, 0.8, 0.7][index]!] as const)) {
          assert.ok(Math.abs(memory.score - score) < 1e-6, `${memory.fact} scored ${memory.score}`);
        }
      });

      it("leaves out a fact scoring 0.25 and keeps one scoring 0.35", async () => {
        const store = fresh({ low: scoredAgainst(0, 0.25, 10), high: scoredAgainst(0, 0.35, 11) });
        await store.remember("oncall-a", "low");
        await store.remember("oncall-a", "high");
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), ["high"]);
      });

      it("orders equal scores newest first", async () => {
        const store = fresh({ older: scoredAgainst(0, 0.5, 10), newer: scoredAgainst(0, 0.5, 11) });
        await store.remember("oncall-a", "older");
        await store.remember("oncall-a", "newer");
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), ["newer", "older"]);
      });

      it("recalls nothing for a user with no memories", async () => {
        assert.deepEqual(await fresh({}).recall("nobody", QUERY), []);
      });

      it("never recalls another user's memories", async () => {
        const store = fresh({ mine: scoredAgainst(0, 0.9, 10), theirs: scoredAgainst(0, 0.9, 11) });
        await store.remember("oncall-a", "mine");
        await store.remember("oncall-b", "theirs");
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), ["mine"]);
        assert.deepEqual((await store.recall("oncall-b", QUERY)).map((memory) => memory.fact), ["theirs"]);
      });

      it("rejects an empty, a whitespace-only, and a 501-character fact, storing nothing", async () => {
        const long = "x".repeat(501);
        const store = fresh({ "": scoredAgainst(0, 0.9), [long]: scoredAgainst(0, 0.9) });
        for (const fact of ["", "   ", long]) await assert.rejects(store.remember("oncall-a", fact));
        assert.deepEqual(await store.recall("oncall-a", QUERY), []);
      });

      it("stores quotes and SQL-like text verbatim", async () => {
        const awkward = "x'); DROP TABLE memories;--";
        const store = fresh({ [awkward]: scoredAgainst(0, 0.9) });
        await store.remember("oncall-a", awkward);
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), [awkward]);
      });
    });

    describe("deduplication", () => {
      // "reworded" scores 0.95 against "original", and "related" 0.9: both sit on axis 0 and 1.
      const original = unitVector({ 0: 1 });
      const vectors = {
        original,
        reworded: scoredAgainst(0, 0.95, 1),
        related: scoredAgainst(0, 0.9, 1),
      };

      it("returns the existing memory for a fact scoring above 0.92, storing nothing", async () => {
        const store = fresh(vectors);
        const first = await store.remember("oncall-a", "original");
        const second = await store.remember("oncall-a", "reworded");
        assert.equal(second.created, false);
        assert.deepEqual(second.memory, first.memory);
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), ["original"]);
      });

      it("stores a fact scoring 0.9 as a new memory", async () => {
        const store = fresh(vectors);
        await store.remember("oncall-a", "original");
        const second = await store.remember("oncall-a", "related");
        assert.equal(second.created, true);
        assert.equal((await store.recall("oncall-a", QUERY)).length, 2);
      });

      it("never deduplicates across users", async () => {
        const store = fresh(vectors);
        const mine = await store.remember("oncall-a", "original");
        const theirs = await store.remember("oncall-b", "original");
        assert.equal(theirs.created, true);
        assert.notEqual(theirs.memory.id, mine.memory.id);
        assert.equal(theirs.memory.userId, "oncall-b");
      });
    });

    describe("forget", () => {
      const vectors = { kept: scoredAgainst(0, 0.8, 10), dropped: scoredAgainst(0, 0.7, 11) };

      it("removes the memory, so recall no longer returns it", async () => {
        const store = fresh(vectors);
        await store.remember("oncall-a", "kept");
        const { memory } = await store.remember("oncall-a", "dropped");
        store.forget("oncall-a", memory.id);
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((recalled) => recalled.fact), ["kept"]);
      });

      it("throws MemoryNotFoundError for an unknown id or another user's id, removing nothing", async () => {
        const store = fresh(vectors);
        const { memory } = await store.remember("oncall-a", "kept");
        const notFound = (id: number) => (error: unknown) => error instanceof MemoryNotFoundError && error.memoryId === id;
        assert.throws(() => store.forget("oncall-a", 999), notFound(999));
        assert.throws(() => store.forget("oncall-b", memory.id), notFound(memory.id));
        assert.deepEqual((await store.recall("oncall-a", QUERY)).map((recalled) => recalled.fact), ["kept"]);
      });
    });
  });
}
