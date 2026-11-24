import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmbeddingError } from "../domain/errors.ts";
import { createLazyEmbedder, EMBEDDING_DIMENSIONS, localEmbedder, type Extract } from "./embeddings.ts";
import { SqliteMemoryStore } from "./memory-store.ts";

const vectorOf = (length: number): Extract => async () => new Float32Array(length).fill(1 / Math.sqrt(length));

describe("createLazyEmbedder", () => {
  it("loads once, even for calls made while the load is still running", async () => {
    let loads = 0;
    const embedder = createLazyEmbedder(async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return vectorOf(EMBEDDING_DIMENSIONS);
    });
    await Promise.all([embedder.embed("a"), embedder.embed("b")]);
    await embedder.embed("c");
    assert.equal(loads, 1);
  });

  it("tries again after a failed load", async () => {
    let loads = 0;
    const embedder = createLazyEmbedder(async () => {
      loads += 1;
      if (loads === 1) throw new Error("network down");
      return vectorOf(EMBEDDING_DIMENSIONS);
    });
    await assert.rejects(embedder.embed("a"), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.match(error.message, /network down/);
      return true;
    });
    assert.equal((await embedder.embed("a")).length, EMBEDDING_DIMENSIONS);
    assert.equal(loads, 2);
  });

  it("turns a load that throws synchronously into EmbeddingError", async () => {
    const embedder = createLazyEmbedder(() => {
      throw new Error("bad install");
    });
    await assert.rejects(embedder.embed("a"), EmbeddingError);
  });

  it("rejects a vector of the wrong size", async () => {
    const embedder = createLazyEmbedder(async () => vectorOf(10));
    await assert.rejects(embedder.embed("a"), /expected 384 values, got 10/);
  });

  it("returns a Float32Array even when the model gives a plain array", async () => {
    const embedder = createLazyEmbedder(async () => async () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0));
    assert.ok((await embedder.embed("a")) instanceof Float32Array);
  });
});

// The only test that loads the real model: about 90 MB on the first run, cached after that.
const skipReason =
  process.env.OPSPILOT_SKIP_MODEL_TESTS === "1" ? "OPSPILOT_SKIP_MODEL_TESTS=1: real-model test skipped" : false;

describe("localEmbedder (real all-MiniLM-L6-v2)", { skip: skipReason, timeout: 300_000 }, () => {
  it("returns 384 values of unit length", async () => {
    const vector = await localEmbedder.embed("The payments team owns the checkout service");
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-4);
  });

  // SC-001: the query and the fact share no word. Only the side of the threshold is asserted.
  it("recalls a fact that shares no word with the query", async () => {
    const store = new SqliteMemoryStore(":memory:", { embedder: localEmbedder });
    try {
      await store.remember("oncall-a", "The payments team owns the checkout service");
      await store.remember("oncall-a", "my favourite colour is green");
      const recalled = await store.recall("oncall-a", "who should I page about failed purchases?");
      assert.deepEqual(
        recalled.map((memory) => memory.fact),
        ["The payments team owns the checkout service"],
      );
    } finally {
      store.close();
    }
  });

  it("puts the closest fact first", async () => {
    const store = new SqliteMemoryStore(":memory:", { embedder: localEmbedder });
    try {
      await store.remember("oncall-a", "I prefer answers in short bullet lists");
      await store.remember("oncall-a", "The payments team owns the checkout service");
      const [first] = await store.recall("oncall-a", "keep replies brief, please");
      assert.equal(first?.fact, "I prefer answers in short bullet lists");
    } finally {
      store.close();
    }
  });
});
