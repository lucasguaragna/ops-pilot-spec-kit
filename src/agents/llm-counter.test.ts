import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { providerError } from "../testing/provider-errors.ts";
import { ScriptedChatModel, textTurn, toolCallTurn, withUsage } from "../testing/scripted-chat-model.ts";
import { fallbackEvents, LlmCallCounter } from "./llm-counter.ts";
import { createResilientModel } from "./resilient-model.ts";

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

describe("LlmCallCounter: switches and modelUsed", () => {
  const rateLimited = () => providerError(429, "RateLimitError", "PROVIDER-SECRET-TEXT");
  const resilient = (primary: ScriptedChatModel, fallback: ScriptedChatModel, attempts = 1) =>
    createResilientModel({ primary: { model: primary, name: "p" }, fallback: { model: fallback, name: "f" }, attempts });

  it("counts every attempt and records one switch with the primary's error class", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited()]), new ScriptedChatModel([textTurn("ok")]), 2);
    const counter = new LlmCallCounter();
    await model.invoke("hi", { callbacks: [counter] });
    assert.equal(counter.count, 3);
    assert.deepEqual(counter.switches, [{ from: "p", to: "f", error: "RateLimitError" }]);
    assert.equal(counter.modelUsed, "f");
  });

  it("records one switch for a fallback that retries", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited()]), new ScriptedChatModel([rateLimited(), textTurn("ok")]), 2);
    const counter = new LlmCallCounter();
    await model.invoke("hi", { callbacks: [counter] });
    assert.equal(counter.count, 4);
    assert.equal(counter.switches.length, 1);
  });

  it("records no switch when the primary answers, and reports the primary", async () => {
    const model = resilient(new ScriptedChatModel([textTurn("ok")]), new ScriptedChatModel([textTurn("fb")]));
    const counter = new LlmCallCounter();
    await model.invoke("hi", { callbacks: [counter] });
    assert.deepEqual(counter.switches, []);
    assert.equal(counter.modelUsed, "p");
  });

  it("keeps the model of the last finished call across calls", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited(), textTurn("back")]), new ScriptedChatModel([textTurn("fb")]));
    const counter = new LlmCallCounter();
    await model.invoke("one", { callbacks: [counter] });
    await model.invoke("two", { callbacks: [counter] });
    assert.equal(counter.switches.length, 1);
    assert.equal(counter.modelUsed, "p");
  });

  it("leaves modelUsed null when every call failed", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited()]), new ScriptedChatModel([rateLimited()]));
    const counter = new LlmCallCounter();
    await assert.rejects(model.invoke("hi", { callbacks: [counter] }));
    assert.equal(counter.modelUsed, null);
    assert.equal(counter.count, 2);
  });

  it("leaves modelUsed null for a plain model that carries no name", async () => {
    const counter = new LlmCallCounter();
    await new ScriptedChatModel([textTurn("ok")]).invoke("hi", { callbacks: [counter] });
    assert.equal(counter.modelUsed, null);
    assert.deepEqual(counter.switches, []);
  });

  it("sees the switch of a structured output call too", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited()]), new ScriptedChatModel([toolCallTurn("pick", { color: "red" })]));
    const structured = model.withStructuredOutput(z.object({ color: z.string() }), {
      name: "pick",
      method: "functionCalling",
      includeRaw: true,
    });
    const counter = new LlmCallCounter();
    await structured.invoke("hi", { callbacks: [counter] });
    assert.deepEqual(counter.switches, [{ from: "p", to: "f", error: "RateLimitError" }]);
  });

  it("takeSwitches returns the switches once", async () => {
    const model = resilient(new ScriptedChatModel([rateLimited()]), new ScriptedChatModel([textTurn("ok")]));
    const counter = new LlmCallCounter();
    await model.invoke("hi", { callbacks: [counter] });
    assert.equal(counter.takeSwitches().length, 1);
    assert.deepEqual(counter.takeSwitches(), []);
  });
});

describe("fallbackEvents", () => {
  it("maps each switch to a fallback event, in order", () => {
    assert.deepEqual(
      fallbackEvents([
        { from: "p", to: "f", error: "RateLimitError" },
        { from: "p", to: "f", error: "TimeoutError" },
      ]),
      [
        { type: "fallback", from: "p", to: "f", error: "RateLimitError" },
        { type: "fallback", from: "p", to: "f", error: "TimeoutError" },
      ],
    );
  });
});
