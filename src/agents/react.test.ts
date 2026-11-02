import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "../store/in-memory-store.ts";
import { ScriptedChatModel, textTurn, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { createReactStrategy } from "./react.ts";
import { createTools } from "./tools.ts";

function strategyWith(model: ScriptedChatModel) {
  return createReactStrategy({ model, tools: [...createTools(createStore())] });
}

describe("react strategy", () => {
  it("completes with an ordered trace and counted LLM calls", async () => {
    const model = new ScriptedChatModel([
      toolCallTurn("list_alerts", { status: "firing" }, "Checking firing alerts."),
      textTurn("Three alerts are firing."),
    ]);
    const result = await strategyWith(model).run("What is firing?", { maxIterations: 5 });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Three alerts are firing.");
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["thought", "action", "observation", "answer"],
    );
    assert.equal(result.metrics.llmCalls, 2);
    assert.equal(result.metrics.llmCalls, model.calls);
    assert.ok(result.metrics.latencyMs >= 0);
  });

  it("stops with iteration_limit when the model keeps calling tools", async () => {
    const model = new ScriptedChatModel([toolCallTurn("list_alerts", { status: "all" })]);
    const result = await strategyWith(model).run("Loop forever", { maxIterations: 3 });

    assert.equal(result.stopReason, "iteration_limit");
    assert.equal(result.answer, null);
    assert.equal(result.metrics.llmCalls, 3);
    assert.equal(result.trace.filter((event) => event.type === "action").length, 3);
  });

  it("returns an error result and keeps the partial trace when the model fails", async () => {
    const model = new ScriptedChatModel([
      toolCallTurn("list_alerts", { status: "firing" }),
      new Error("Provider unavailable"),
    ]);
    const result = await strategyWith(model).run("What is firing?", { maxIterations: 5 });

    assert.equal(result.stopReason, "error");
    assert.equal(result.answer, null);
    if (result.stopReason === "error") assert.match(result.error.message, /Provider unavailable/);
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["action", "observation"],
    );
  });
});
