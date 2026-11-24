import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReasoningStrategy, RunOptions, RunResult } from "../domain/types.ts";
import { withHistory } from "./history.ts";
import { composeMemoryInput, memoryBlock, withMemories } from "./memories.ts";

const facts = [
  { id: 7, fact: "The payments team owns the checkout service" },
  { id: 3, fact: "I prefer answers in short bullet lists" },
];

describe("composeMemoryInput", () => {
  it("returns the input unchanged when nothing was recalled", () => {
    assert.equal(composeMemoryInput([], "hi"), "hi");
  });

  it("lists the facts with their ids, in order, ahead of the input", () => {
    assert.equal(
      composeMemoryInput(facts, "who should I page?"),
      "Facts remembered about this engineer (best match first; they may be out of date):\n" +
        "- [memory 7] The payments team owns the checkout service\n" +
        "- [memory 3] I prefer answers in short bullet lists\n\n" +
        "who should I page?",
    );
  });
});

describe("memoryBlock", () => {
  it("is empty when nothing was recalled", () => {
    assert.equal(memoryBlock([]), "");
  });

  it("is everything composeMemoryInput puts ahead of the input", () => {
    assert.equal(
      memoryBlock(facts),
      "Facts remembered about this engineer (best match first; they may be out of date):\n" +
        "- [memory 7] The payments team owns the checkout service\n" +
        "- [memory 3] I prefer answers in short bullet lists\n\n",
    );
  });

  it("composeMemoryInput is the block followed by the input, for any facts", () => {
    for (const recalled of [[], facts, facts.slice(0, 1)]) {
      assert.equal(composeMemoryInput(recalled, "hello"), memoryBlock(recalled) + "hello");
    }
  });
});

describe("withMemories", () => {
  const recording = () => {
    const calls: { input: string; options: RunOptions }[] = [];
    const strategy: ReasoningStrategy = {
      name: "react",
      async run(input, options) {
        calls.push({ input, options });
        return { stopReason: "completed", answer: "ok", trace: [], metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null } } as RunResult;
      },
    };
    return { strategy, calls };
  };

  it("keeps the name and passes the composed input and the same options", async () => {
    const { strategy, calls } = recording();
    const wrapped = withMemories(strategy, facts.slice(0, 1));
    const options = { maxIterations: 4 };
    await wrapped.run("next", options);
    assert.equal(wrapped.name, "react");
    assert.equal(calls[0]?.input, composeMemoryInput(facts.slice(0, 1), "next"));
    assert.equal(calls[0]?.options, options);
  });

  it("inside withHistory, gives the facts first, then the conversation, then the request", async () => {
    const { strategy, calls } = recording();
    const wrapped = withHistory(withMemories(strategy, facts.slice(0, 1)), [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ]);
    await wrapped.run("now", { maxIterations: 4 });
    const input = calls[0]!.input;
    const factsAt = input.indexOf("Facts remembered");
    const conversationAt = input.indexOf("Conversation so far");
    const requestAt = input.indexOf("Current request: now");
    assert.ok(factsAt === 0 && factsAt < conversationAt && conversationAt < requestAt, input);
  });
});

describe("withMemories: systemPrompt", () => {
  const base = (extra: Partial<ReasoningStrategy>): ReasoningStrategy => ({
    name: "react",
    async run() {
      throw new Error("not called");
    },
    ...extra,
  });

  it("exposes the wrapped strategy's system prompt", () => {
    assert.equal(withMemories(base({ systemPrompt: "S" }), facts).systemPrompt, "S");
  });

  it("has no systemPrompt key when the wrapped strategy has none", () => {
    assert.equal("systemPrompt" in withMemories(base({}), facts), false);
  });
});
