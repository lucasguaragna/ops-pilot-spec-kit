import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { FakeMemoryStore } from "../testing/fake-memory-store.ts";
import { ScriptedChatModel, textTurn, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { createMemoryTools } from "./memory-tools.ts";
import { createReactStrategy } from "./react.ts";

const FACT = "The payments team owns the checkout service";
const REWORDED = "The payments team is responsible for the checkout service";
const QUERY = "who owns checkout?";

const freshStore = () =>
  new FakeMemoryStore({
    embedder: new FakeEmbedder({
      [FACT]: unitVector({ 0: 1 }),
      [REWORDED]: scoredAgainst(0, 0.95, 1),
      [QUERY]: unitVector({ 0: 1 }),
    }),
  });

const rememberFactOf = (store: FakeMemoryStore, userId: string) => createMemoryTools(store, userId)[0];
const forgetFactOf = (store: FakeMemoryStore, userId: string) => createMemoryTools(store, userId)[1];
const forgetPreferenceOf = (store: FakeMemoryStore, userId: string) => createMemoryTools(store, userId)[2];

it("builds remember_fact, forget_fact, and forget_preference, in that order", () => {
  assert.deepEqual(createMemoryTools(freshStore(), "oncall-a").map((tool) => tool.name), [
    "remember_fact",
    "forget_fact",
    "forget_preference",
  ]);
});

describe("forget_preference", () => {
  const UNRELATED = "prefers bullet lists";
  const store = () =>
    new FakeMemoryStore({
      embedder: new FakeEmbedder({
        [FACT]: unitVector({ 0: 1 }),
        [REWORDED]: scoredAgainst(0, 0.95, 1),
        [UNRELATED]: scoredAgainst(0, 0.2, 2),
        [QUERY]: unitVector({ 0: 1 }),
      }),
    });

  it("has a description and no user id in its schema", () => {
    assert.deepEqual(Object.keys(forgetPreferenceOf(store(), "oncall-a").schema.shape), ["description"]);
  });

  it("forgets the closest matching fact and names it", async () => {
    const memories = store();
    const { memory } = await memories.remember("oncall-a", FACT);
    const output = JSON.parse(await forgetPreferenceOf(memories, "oncall-a").invoke({ description: REWORDED }));
    assert.deepEqual(output, { id: memory.id, fact: FACT, forgotten: true });
    assert.deepEqual(await memories.recall("oncall-a", QUERY), []);
  });

  it("reports forgotten false and removes nothing when no fact matches", async () => {
    const memories = store();
    await memories.remember("oncall-a", FACT);
    const output = JSON.parse(await forgetPreferenceOf(memories, "oncall-a").invoke({ description: UNRELATED }));
    assert.deepEqual(output, { forgotten: false });
    assert.equal((await memories.recall("oncall-a", QUERY)).length, 1);
  });

  it("returns a blank description to the model as a tool error and lets the run finish (FR-012)", async () => {
    const memories = store();
    await memories.remember("oncall-a", FACT);
    const model = new ScriptedChatModel([toolCallTurn("forget_preference", { description: "  " }), textTurn("Nothing removed.")]);
    const strategy = createReactStrategy({ model, tools: [...createMemoryTools(memories, "oncall-a")] });

    const result = await strategy.run("forget nothing", { maxIterations: 4 });

    assert.equal(result.stopReason, "completed");
    const observation = result.trace.find((event) => event.type === "observation");
    assert.ok(observation && observation.type === "observation");
    assert.match(observation.content, /error/i);
    assert.equal((await memories.recall("oncall-a", QUERY)).length, 1);
  });

  it("never removes another user's identical fact (FR-010)", async () => {
    const memories = store();
    await memories.remember("oncall-b", FACT);
    const output = JSON.parse(await forgetPreferenceOf(memories, "oncall-a").invoke({ description: REWORDED }));
    assert.deepEqual(output, { forgotten: false });
    assert.equal((await memories.recall("oncall-b", QUERY)).length, 1);
  });
});

describe("forget_fact", () => {
  it("has no user id in its schema", () => {
    const tool = forgetFactOf(freshStore(), "oncall-a");
    assert.deepEqual(Object.keys(tool.schema.shape), ["id"]);
  });

  it("forgets the bound user's fact and returns id and forgotten", async () => {
    const store = freshStore();
    const { memory } = await store.remember("oncall-a", FACT);
    const tool = forgetFactOf(store, "oncall-a");

    assert.deepEqual(JSON.parse(await tool.invoke({ id: memory.id })), { id: memory.id, forgotten: true });
    assert.deepEqual(await store.recall("oncall-a", QUERY), []);
  });

  it("answers with an error text for an unknown id, or another user's", async () => {
    const store = freshStore();
    const { memory } = await store.remember("oncall-a", FACT);
    const othersTool = forgetFactOf(store, "oncall-b");

    assert.equal(await othersTool.invoke({ id: memory.id }), `Error: Memory not found: ${memory.id}`);
    assert.equal((await store.recall("oncall-a", QUERY)).length, 1);
  });
});

describe("remember_fact", () => {
  it("has no user id in its schema", () => {
    const tool = rememberFactOf(freshStore(), "oncall-a");
    assert.deepEqual(Object.keys(tool.schema.shape), ["fact"]);
  });

  it("stores the fact for the bound user and returns id, fact, and created", async () => {
    const store = freshStore();
    const tool = rememberFactOf(store, "oncall-a");

    const output = JSON.parse(await tool.invoke({ fact: FACT }));

    assert.deepEqual(output, { id: 1, fact: FACT, created: true });
    assert.deepEqual((await store.recall("oncall-a", QUERY)).map((memory) => memory.fact), [FACT]);
  });

  it("reports created false for a near-duplicate", async () => {
    const tool = rememberFactOf(freshStore(), "oncall-a");
    await tool.invoke({ fact: FACT });
    assert.deepEqual(JSON.parse(await tool.invoke({ fact: REWORDED })), { id: 1, fact: FACT, created: false });
  });

  it("keeps each user's facts apart", async () => {
    const store = freshStore();
    await rememberFactOf(store, "oncall-a").invoke({ fact: FACT });
    assert.deepEqual(await store.recall("oncall-b", QUERY), []);
  });

  it("returns invalid input to the model and lets the run finish (FR-019)", async () => {
    const store = freshStore();
    const model = new ScriptedChatModel([toolCallTurn("remember_fact", { fact: "" }), textTurn("Nothing to save.")]);
    const strategy = createReactStrategy({ model, tools: [...createMemoryTools(store, "oncall-a")] });

    const result = await strategy.run("remember nothing", { maxIterations: 4 });

    assert.equal(result.stopReason, "completed");
    const observation = result.trace.find((event) => event.type === "observation");
    assert.ok(observation && observation.type === "observation");
    assert.match(observation.content, /error/i);
    assert.deepEqual(await store.recall("oncall-a", QUERY), []);
  });
});
