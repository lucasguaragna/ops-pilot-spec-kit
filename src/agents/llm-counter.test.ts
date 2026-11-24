import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedChatModel, textTurn, withUsage } from "../testing/scripted-chat-model.ts";
import { LlmCallCounter } from "./llm-counter.ts";

describe("LlmCallCounter", () => {
  it("counts every call made through a model", async () => {
    const model = new ScriptedChatModel([textTurn("one"), textTurn("two"), textTurn("three")]);
    const counter = new LlmCallCounter();
    for (let call = 0; call < 3; call += 1) {
      await model.invoke("hello", { callbacks: [counter] });
    }
    assert.equal(counter.count, 3);
    assert.equal(counter.count, model.calls);
  });

  it("starts with no reported prompt tokens", () => {
    assert.equal(new LlmCallCounter().promptTokens, null);
  });

  it("sums the input tokens the provider reported for each call", async () => {
    const model = new ScriptedChatModel([withUsage(textTurn("a"), 100), withUsage(textTurn("b"), 50)]);
    const counter = new LlmCallCounter();
    await model.invoke("one", { callbacks: [counter] });
    await model.invoke("two", { callbacks: [counter] });
    assert.equal(counter.promptTokens, 150);
    assert.equal(counter.count, 2);
  });

  it("sums only the calls that reported usage", async () => {
    const model = new ScriptedChatModel([withUsage(textTurn("a"), 100), textTurn("b")]);
    const counter = new LlmCallCounter();
    await model.invoke("one", { callbacks: [counter] });
    await model.invoke("two", { callbacks: [counter] });
    assert.equal(counter.promptTokens, 100);
    assert.equal(counter.count, 2);
  });

  it("stays null when no call reported usage", async () => {
    const model = new ScriptedChatModel([textTurn("a"), textTurn("b")]);
    const counter = new LlmCallCounter();
    await model.invoke("one", { callbacks: [counter] });
    await model.invoke("two", { callbacks: [counter] });
    assert.equal(counter.promptTokens, null);
    assert.equal(counter.count, 2);
  });
});
