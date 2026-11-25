import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createResilientModel } from "../agents/resilient-model.ts";
import { providerError } from "../testing/provider-errors.ts";
import { ScriptedChatModel, textTurn, toolCallTurn, withUsage } from "../testing/scripted-chat-model.ts";
import { createRouter, ROUTE_TOOL_NAME } from "./router.ts";

const router = (model: ScriptedChatModel) => createRouter({ model: model as unknown as BaseChatModel });

describe("createRouter", () => {
  it("returns the router's choice with its call and tokens counted", async () => {
    const model = new ScriptedChatModel([
      withUsage(toolCallTurn(ROUTE_TOOL_NAME, { route: "plan-execute", reason: "Several alerts" }), 321),
    ]);
    const outcome = await router(model).route("Open an incident for each alert", {});
    assert.deepEqual(outcome.decision, { route: "plan-execute", reason: "Several alerts", source: "router" });
    assert.equal(outcome.llmCalls, 1);
    assert.equal(outcome.promptTokens, 321);
    assert.equal(model.calls, 1);
  });

  it("falls back to react when the model answers in text", async () => {
    const outcome = await router(new ScriptedChatModel([textTurn("react")])).route("hi", {});
    assert.deepEqual(outcome.decision, { route: "react", reason: "Router failed: invalid answer", source: "fallback" });
    assert.equal(outcome.llmCalls, 1);
  });

  it("falls back to react for a route that does not exist, without a retry", async () => {
    const model = new ScriptedChatModel([toolCallTurn(ROUTE_TOOL_NAME, { route: "nope", reason: "x" })]);
    const outcome = await router(model).route("hi", {});
    assert.equal(outcome.decision.source, "fallback");
    assert.equal(model.calls, 1);
  });

  it("falls back to react when the model throws, naming only the error class", async () => {
    const outcome = await router(new ScriptedChatModel([new TypeError("provider secret")])).route("hi", {});
    assert.deepEqual(outcome.decision, { route: "react", reason: "Router failed: TypeError", source: "fallback" });
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    await assert.rejects(router(new ScriptedChatModel([textTurn("x")])).route("hi", { signal: controller.signal }), /timed out/);
  });
});

describe("createRouter: model fallback", () => {
  const resilient = (primary: ScriptedChatModel, fallback: ScriptedChatModel) =>
    createRouter({
      model: createResilientModel({
        primary: { model: primary, name: "p" },
        fallback: { model: fallback, name: "f" },
        attempts: 1,
      }),
    });
  const down = () => providerError(503, "InternalServerError", "PROVIDER-SECRET-TEXT");

  it("keeps the router's own decision when the fallback answers, and reports the switch", async () => {
    const fallback = new ScriptedChatModel([toolCallTurn(ROUTE_TOOL_NAME, { route: "plan-execute", reason: "Several alerts" })]);
    const outcome = await resilient(new ScriptedChatModel([down()]), fallback).route("hi", {});
    assert.deepEqual(outcome.decision, { route: "plan-execute", reason: "Several alerts", source: "router" });
    assert.deepEqual(outcome.switches, [{ from: "p", to: "f", error: "InternalServerError" }]);
    assert.equal(outcome.modelUsed, "f");
    assert.equal(outcome.llmCalls, 2);
  });

  it("falls back to react without a second switch when the fallback answers in text", async () => {
    const fallback = new ScriptedChatModel([textTurn("react")]);
    const outcome = await resilient(new ScriptedChatModel([down()]), fallback).route("hi", {});
    assert.equal(outcome.decision.source, "fallback");
    assert.equal(outcome.switches.length, 1);
    assert.equal(fallback.calls, 1);
  });

  it("still reports the switches when every model fails", async () => {
    const outcome = await resilient(new ScriptedChatModel([down()]), new ScriptedChatModel([down()])).route("hi", {});
    assert.deepEqual(outcome.decision, { route: "react", reason: "Router failed: ModelUnavailableError", source: "fallback" });
    assert.equal(outcome.switches.length, 1);
    assert.equal(outcome.modelUsed, null);
  });
});
