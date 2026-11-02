import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "../store/in-memory-store.ts";
import { ScriptedChatModel, textTurn, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createReactStrategy, GROUNDING_ATTEMPTS, hasToolResult } from "./react.ts";
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

describe("react tool-use guard", () => {
  it("knows when a tool has answered", () => {
    assert.equal(hasToolResult([new HumanMessage("What is firing?")]), false);
    assert.equal(hasToolResult([new ToolMessage({ content: "[]", tool_call_id: "call-1" })]), true);
  });

  it("re-asks the model when it answers before using any tool", async () => {
    const model = new ScriptedChatModel([
      textTurn("I have no access to your monitoring."),
      toolCallTurn("list_alerts", { status: "firing" }),
      textTurn("Four alerts are firing."),
    ]);
    const result = await strategyWith(model).run("What is firing?", { maxIterations: 5 });

    assert.equal(result.answer, "Four alerts are firing.");
    assert.equal(result.metrics.llmCalls, 3);
    assert.equal(result.trace.filter((event) => event.type === "action").length, 1);
  });

  it("accepts a plain answer after the grounding attempts run out", async () => {
    const model = new ScriptedChatModel([textTurn("Hello! How can I help?")]);
    const result = await strategyWith(model).run("Hi", { maxIterations: 5 });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Hello! How can I help?");
    assert.equal(result.metrics.llmCalls, GROUNDING_ATTEMPTS);
  });

  it("does not re-ask once a tool has answered", async () => {
    const model = new ScriptedChatModel([
      toolCallTurn("list_alerts", { status: "firing" }),
      textTurn("Four alerts are firing."),
    ]);
    const result = await strategyWith(model).run("What is firing?", { maxIterations: 5 });
    assert.equal(result.metrics.llmCalls, 2);
  });
});

describe("react strategy: abort signal", () => {
  it("makes no model call when the signal is already aborted", async () => {
    const model = new ScriptedChatModel([textTurn("never")]);
    const controller = new AbortController();
    controller.abort();

    const result = await strategyWith(model).run("hi", { maxIterations: 5, signal: controller.signal });

    assert.equal(result.stopReason, "error");
    assert.equal(model.calls, 0);
  });

  it("starts no model call after a tool aborts the run", async () => {
    const controller = new AbortController();
    const abortNow = tool(
      async () => {
        controller.abort();
        return "aborted";
      },
      { name: "abort_now", description: "Aborts the run", schema: z.object({}) },
    );
    const model = new ScriptedChatModel([toolCallTurn("abort_now", {}), textTurn("never")]);
    const strategy = createReactStrategy({ model, tools: [abortNow] });

    const result = await strategy.run("hi", { maxIterations: 5, signal: controller.signal });

    assert.equal(result.stopReason, "error");
    assert.equal(model.calls, 1);
  });
});
