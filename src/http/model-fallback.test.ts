import assert from "node:assert/strict";
import { after, describe, it, mock } from "node:test";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { strategyFactories } from "../agents/index.ts";
import { createResilientModel } from "../agents/resilient-model.ts";
import { createRouter, ROUTE_TOOL_NAME } from "../graph/router.ts";
import { NO_LEARNING } from "../testing/learning-turns.ts";
import { providerError } from "../testing/provider-errors.ts";
import { ScriptedChatModel, textTurn, toolCallTurn, type ScriptedTurn } from "../testing/scripted-chat-model.ts";
import { FakeConversationStore } from "../testing/fake-conversation-store.ts";
import { hangingTurn } from "../testing/scripted-chat-model.ts";
import { closeServers, completed, fakeStrategy, postChat, settingsFor, startServer } from "../testing/test-server.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { ChatReply, ErrorReply } from "./schemas.ts";

after(closeServers);

const PROVIDER_TEXT = "PROVIDER-SECRET-TEXT";
const ANSWER = "Two alerts are firing.";
const listAlerts = tool(async () => "[]", { name: "list_alerts", description: "Lists alerts", schema: z.object({}) });
const routeTurn = toolCallTurn(ROUTE_TOOL_NAME, { route: "react", reason: "A lookup" });

/** The real graph, router and ReAct strategy over a resilient model made of two scripted models. */
async function serve(primaryTurns: readonly ScriptedTurn[], fallbackTurns?: readonly ScriptedTurn[], extra = {}) {
  const primary = new ScriptedChatModel(primaryTurns);
  const fallback = fallbackTurns && new ScriptedChatModel(fallbackTurns);
  const model = createResilientModel({
    primary: { model: primary, name: "primary/model" },
    fallback: fallback && { model: fallback, name: "backup/model" },
    attempts: 1,
  });
  const background = new BackgroundTasks();
  const baseUrl = await startServer(
    settingsFor({}, { registry: strategyFactories, createRouter: (model) => createRouter({ model }), createDependencies: () => ({ model, tools: [listAlerts] }), background, ...extra }),
  );
  return { baseUrl, primary, fallback, background };
}

describe("POST /chat: the primary model is down", () => {
  it("answers 200 with the fallback's answer (US1)", async () => {
    const { baseUrl, primary, fallback, background } = await serve(
      [providerError(503, "InternalServerError", PROVIDER_TEXT)],
      [routeTurn, toolCallTurn("list_alerts", {}), textTurn(ANSWER), NO_LEARNING],
    );

    const { status, json } = await postChat(baseUrl, { message: "Which alerts are firing?" });
    await background.settled();

    assert.equal(status, 200);
    assert.equal(json.answer, ANSWER);
    assert.equal(json.stopReason, "completed");
    assert.ok(ChatReply.safeParse(json).success);
    assert.ok(primary.calls >= 3, "the primary is tried first on every call");
    assert.ok((fallback?.calls ?? 0) >= 3);
  });
});

const firstQuestion = { message: "Which alerts are firing?" };
const happyPath = [routeTurn, toolCallTurn("list_alerts", {}), textTurn(ANSWER), NO_LEARNING];

describe("POST /chat: the trace and metrics name the model", () => {
  it("shows each switch with its node and names the fallback as the model used (US2)", async () => {
    const { baseUrl, background } = await serve(
      [providerError(429, "RateLimitError", PROVIDER_TEXT)],
      happyPath,
    );

    const { status, json } = await postChat(baseUrl, firstQuestion);
    await background.settled();

    assert.equal(status, 200);
    assert.ok(ChatReply.safeParse(json).success);
    const switches = json.trace.filter((event: { type: string }) => event.type === "fallback");
    // One for the router, and one for each of ReAct's two calls.
    assert.deepEqual(switches.map((event: { node: string }) => event.node), ["router", "react", "react"]);
    assert.deepEqual(switches[0], { node: "router", type: "fallback", from: "primary/model", to: "backup/model", error: "RateLimitError" });
    const route = json.trace.findIndex((event: { type: string }) => event.type === "route");
    assert.ok(json.trace.findIndex((event: { type: string }) => event.type === "fallback") < route, "the router's switch comes first");
    assert.equal(json.metrics.modelUsed, "backup/model");
    // Router: 1 failed + 1 answered. ReAct: two calls, each 1 failed + 1 answered.
    assert.equal(json.metrics.llmCalls, 6);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(PROVIDER_TEXT));
  });

  it("adds no fallback event and no extra call when the primary works (SC-004)", async () => {
    const { baseUrl, fallback, background } = await serve(happyPath, [textTurn("unused")]);

    const { status, json } = await postChat(baseUrl, firstQuestion);
    await background.settled();

    assert.equal(status, 200);
    assert.equal(json.trace.some((event: { type: string }) => event.type === "fallback"), false);
    assert.equal(json.metrics.modelUsed, "primary/model");
    assert.equal(json.metrics.llmCalls, 3);
    assert.equal(fallback?.calls, 0);
  });
});

describe("POST /chat: the summarization falls back too", () => {
  it("traces its switch under context, before the summarize event, and still gets a summary", async () => {
    const conversations = new FakeConversationStore();
    const { id } = conversations.create();
    for (let index = 0; index < 16; index++) {
      conversations.append(id, { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index + 1}` });
    }
    const { baseUrl, background } = await serve(
      [providerError(503, "InternalServerError")],
      [textTurn("- Decision: page the payments team"), routeTurn, toolCallTurn("list_alerts", {}), textTurn(ANSWER), NO_LEARNING],
      { conversations },
    );

    const { status, json } = await postChat(baseUrl, { ...firstQuestion, conversationId: id });
    await background.settled();

    assert.equal(status, 200);
    assert.deepEqual(json.trace.slice(0, 2).map((event: { node: string; type: string }) => `${event.node}:${event.type}`), [
      "context:fallback",
      "context:summarize",
    ]);
    assert.equal(json.trace[0].error, "InternalServerError");
  });
});

describe("POST /chat: no model can answer", () => {
  const SECRET_KEY = "sk-test-SENTINEL";
  const leaking = () => providerError(429, "RateLimitError", `${PROVIDER_TEXT}: Incorrect API key ${SECRET_KEY}`);

  it("replies 503 model_unavailable with the partial trace, and saves nothing (US3)", async () => {
    const conversations = new FakeConversationStore();
    const errors = mock.method(console, "error", () => {});
    try {
      const { baseUrl, background } = await serve([leaking()], [leaking()], { conversations });

      const { status, json } = await postChat(baseUrl, firstQuestion);
      await background.settled();

      assert.equal(status, 503);
      assert.ok(ErrorReply.safeParse(json).success);
      assert.equal(json.error, "model_unavailable");
      assert.equal(json.runError.name, "RateLimitError");
      assert.match(json.conversationId, /\S/);
      assert.deepEqual(
        json.trace.map((event: { node: string; type: string }) => `${event.node}:${event.type}`),
        ["router:fallback", "router:route", "react:fallback"],
      );
      assert.equal(json.trace[1].source, "fallback");
      assert.equal(json.metrics.modelUsed, null);
      assert.equal(conversations.lastMessages(json.conversationId, 10).length, 0);

      // FR-008, FR-013, SC-005: neither the key nor the provider's text reaches the body or the log.
      const logged = errors.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
      assert.match(logged, /ModelUnavailableError.*RateLimitError/);
      for (const text of [JSON.stringify(json), logged]) assert.doesNotMatch(text, new RegExp(`${PROVIDER_TEXT}|${SECRET_KEY}`));
    } finally {
      errors.mock.restore();
    }
  });

  it("replies 503 when there is no fallback and the primary fails (US3 scenario 2)", async () => {
    const { baseUrl, background } = await serve([providerError(503, "InternalServerError")]);
    const { status, json } = await postChat(baseUrl, firstQuestion);
    await background.settled();
    assert.equal(status, 503);
    assert.equal(json.runError.name, "InternalServerError");
    assert.ok(ErrorReply.safeParse(json).success);
  });

  it("keeps 502 for a failure that did not come from a model", async () => {
    const failing = fakeStrategy("react", {
      ...completed("x"),
      stopReason: "error",
      answer: null,
      error: { name: "StoreOpenError", message: "Cannot open database" },
    } as never);
    const errors = mock.method(console, "error", () => {});
    try {
      const baseUrl = await startServer(settingsFor({ react: failing }));
      const { status, json } = await postChat(baseUrl, firstQuestion);
      assert.equal(status, 502);
      assert.equal(json.error, "run_failed");
    } finally {
      errors.mock.restore();
    }
  });

  it("keeps 504 and starts no fallback when the request times out on the primary", async () => {
    const { baseUrl, fallback } = await serve([hangingTurn()], [textTurn("never")], { timeoutMs: 50 });
    const { status, json } = await postChat(baseUrl, firstQuestion);
    assert.equal(status, 504);
    assert.equal(json.error, "timeout");
    assert.equal(fallback?.calls, 0);
  });
});
