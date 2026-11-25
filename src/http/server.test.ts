import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { FakeConversationStore } from "../testing/fake-conversation-store.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { FakeMemoryStore } from "../testing/fake-memory-store.ts";
import { learningTurn } from "../testing/learning-turns.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { ScriptedChatModel, textTurn, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { NO_LEARNING } from "../testing/learning-turns.ts";
import { VERDICT_TOOL_NAME } from "../agents/reflection.ts";
import type { ReasoningStrategy } from "../domain/types.ts";
import { ChatReply, ErrorReply } from "./schemas.ts";
import {
  closeServers,
  completed,
  fakeStrategy,
  postChat,
  settingsFor,
  startServer,
} from "../testing/test-server.ts";

after(closeServers);

describe("POST /chat: successful runs", () => {
  it("runs react by default and replies 200 with answer, trace, and metrics", async () => {
    const react = fakeStrategy("react", completed("Two alerts are firing."));
    const baseUrl = await startServer(settingsFor({ react }));

    const { status, json } = await postChat(baseUrl, { message: "Which alerts are firing?", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, "Two alerts are firing.");
    assert.equal(json.stopReason, "completed");
    assert.equal(json.trace.length, 3);
    assert.deepEqual(json.metrics, {
      llmCalls: 2,
      latencyMs: 15,
      historyMessages: 0,
      recalledMemories: 0,
      promptTokens: null,
      // A fake strategy declares no system prompt and the fake dependencies have no tools ("[]").
      contextBreakdown: { system: 0, tools: 1, history: 0, memories: 0, message: 6, total: 7 },
    });
    assert.equal(typeof json.conversationId, "string");
    assert.equal(react.calls.length, 1);
    assert.equal(react.calls[0]?.input, "Which alerts are firing?");
  });

  it("returns a breakdown whose parts add up to its total, with no history or memories on a first message", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    const { status, json } = await postChat(baseUrl, { message: "Which alerts are firing?", reflect: false });

    assert.equal(status, 200);
    const { contextBreakdown: b } = json.metrics;
    assert.equal(b.history, 0);
    assert.equal(b.memories, 0);
    assert.equal(b.total, b.system + b.tools + b.history + b.memories + b.message);
    assert.ok(ChatReply.safeParse(json).success);
  });

  it("grows the history estimate on the next turn of the same conversation", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("Two alerts are firing.")) }));

    const first = await postChat(baseUrl, { message: "Which alerts are firing?", reflect: false });
    const second = await postChat(baseUrl, {
      message: "And which are resolved?",
      reflect: false,
      conversationId: first.json.conversationId,
    });

    assert.equal(second.status, 200);
    assert.equal(second.json.metrics.historyMessages, 2);
    assert.ok(second.json.metrics.contextBreakdown.history > 0);
    assert.ok(ChatReply.safeParse(second.json).success);
  });

  it("returns the real prompt tokens the strategy reported", async () => {
    const measured = fakeStrategy("react", {
      ...completed("Two alerts are firing."),
      metrics: { llmCalls: 3, latencyMs: 15, promptTokens: 360 },
    });
    const baseUrl = await startServer(settingsFor({ react: measured }));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.metrics.promptTokens, 360);
    assert.ok(ChatReply.safeParse(json).success);
  });

  it("returns null promptTokens, still a 200, when the provider reported no usage", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.metrics.promptTokens, null);
  });

  it("runs the strategy named in the body", async () => {
    const react = fakeStrategy("react", completed("from react"));
    const planExecute = fakeStrategy("plan-execute", completed("from plan"));
    const baseUrl = await startServer(settingsFor({ react, "plan-execute": planExecute }));

    const { status, json } = await postChat(baseUrl, { message: "hi", strategy: "plan-execute", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, "from plan");
    assert.equal(react.calls.length, 0);
  });

  it("replies 200 with a null answer at the iteration limit", async () => {
    const limited = fakeStrategy("react", {
      stopReason: "iteration_limit",
      answer: null,
      trace: [{ type: "thought", content: "still thinking" }],
      metrics: { llmCalls: 10, latencyMs: 99, promptTokens: null },
    });
    const baseUrl = await startServer(settingsFor({ react: limited }));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, null);
    assert.equal(json.stopReason, "iteration_limit");
    assert.deepEqual(json.trace, [{ type: "thought", content: "still thinking" }]);
  });

  it("gives the strategy maxIterations 10", async () => {
    const react = fakeStrategy("react", completed("ok"));
    const baseUrl = await startServer(settingsFor({ react }));

    await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(react.calls[0]?.options.maxIterations, 10);
  });
});

describe("POST /chat: reflection", () => {
  const withApprovingCritic = (react: ReasoningStrategy) =>
    settingsFor(
      { react },
      {
        createDependencies: () => ({
          model: new ScriptedChatModel([toolCallTurn(VERDICT_TOOL_NAME, { approved: true, feedback: "backed" })]),
          tools: [],
        }),
      },
    );

  it("adds a critique event to the trace when reflect is true", async () => {
    const baseUrl = await startServer(withApprovingCritic(fakeStrategy("react", completed("ok"))));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: true });

    assert.equal(status, 200);
    assert.ok(json.trace.some((event: { type: string }) => event.type === "critique"));
  });

  it("leaves the trace without a critique when reflect is false", async () => {
    const baseUrl = await startServer(withApprovingCritic(fakeStrategy("react", completed("ok"))));

    const { json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.ok(!json.trace.some((event: { type: string }) => event.type === "critique"));
  });
});

describe("routing", () => {
  it("replies 404 to GET /chat and POST /other", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    assert.equal((await fetch(`${baseUrl}/chat`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/other`, { method: "POST" })).status, 404);
  });
});

const validBody = { message: "hi", reflect: false };

async function postRaw(baseUrl: string, body?: string): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

describe("POST /chat: invalid requests", () => {
  const bad: [string, unknown, string][] = [
    ["missing message", { reflect: false }, "message"],
    ["blank message", { message: "   ", reflect: false }, "message"],
    ["missing reflect", { message: "hi" }, "reflect"],
    ["string reflect", { message: "hi", reflect: "true" }, "reflect"],
    ["numeric message", { message: 42, reflect: false }, "message"],
  ];
  for (const [label, body, field] of bad) {
    it(`replies 400 with an issue on ${field} for ${label}`, async () => {
      const react = fakeStrategy("react", completed("ok"));
      const baseUrl = await startServer(settingsFor({ react }));

      const { status, json } = await postChat(baseUrl, body);

      assert.equal(status, 400);
      assert.equal(json.error, "invalid_body");
      assert.ok(json.issues.some((issue: { path: unknown[] }) => issue.path[0] === field));
      assert.equal(react.calls.length, 0);
    });
  }

  it("replies 400 with one root issue for a body that is not JSON", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    const { status, json } = await postRaw(baseUrl, "not json");

    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
    assert.deepEqual(json.issues, [{ path: [], message: "The body is not valid JSON" }]);
  });

  it("replies 400 when the request has no body", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status, json } = await postRaw(baseUrl);
    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
  });

  it("checks the body before the strategy name", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status } = await postChat(baseUrl, { strategy: "chain-of-thought" });
    assert.equal(status, 400);
  });

  it("ignores extra fields", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status } = await postChat(baseUrl, { ...validBody, admin: true });
    assert.equal(status, 200);
  });
});

describe("POST /chat: unknown strategy", () => {
  for (const name of ["chain-of-thought", "React", "reflect:react", "toString"]) {
    it(`replies 422 for "${name}" and lists the known names`, async () => {
      const baseUrl = await startServer(
        settingsFor({ react: fakeStrategy("react", completed("a")), "plan-execute": fakeStrategy("plan-execute", completed("b")) }),
      );

      const { status, json } = await postChat(baseUrl, { ...validBody, strategy: name });

      assert.equal(status, 422);
      assert.equal(json.error, "unknown_strategy");
      assert.equal(json.strategy, name);
      assert.deepEqual(json.knownStrategies, ["react", "plan-execute"]);
    });
  }
});

describe("POST /chat: run failures", () => {
  it("replies 502 with the trace when the run returns an error result", async () => {
    const failing = fakeStrategy("react", {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider returned 503" },
      trace: [{ type: "thought", content: "trying" }],
      metrics: { llmCalls: 1, latencyMs: 5, promptTokens: null },
    });
    const baseUrl = await startServer(settingsFor({ react: failing }));

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 502);
    assert.equal(json.error, "run_failed");
    assert.deepEqual(json.runError, { name: "Error", message: "The run failed; details are in the server log" });
    assert.deepEqual(json.trace, [{ type: "thought", content: "trying" }]);
  });

  it("replies 502 without a trace or a stack when the run throws", async () => {
    const throwing = fakeStrategy("react", async () => {
      throw new Error("kaboom");
    });
    const baseUrl = await startServer(settingsFor({ react: throwing }));

    const { status, text, json } = await postRaw(baseUrl, JSON.stringify(validBody));

    assert.equal(status, 502);
    assert.equal(json.runError.message, "The run failed; details are in the server log");
    assert.equal("trace" in json, false);
    assert.ok(!text.includes("kaboom") && !text.includes("stack") && !text.includes(" at "));
  });

  it("replies 504 and aborts the run when it outlives the timeout", async () => {
    let seen: AbortSignal | undefined;
    const slow: ReasoningStrategy = {
      name: "react",
      run: (_input, options) => {
        seen = options.signal;
        return new Promise(() => {});
      },
    };
    const baseUrl = await startServer(settingsFor({ react: slow }, { timeoutMs: 50 }));
    const started = Date.now();

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 504);
    assert.deepEqual(json, {
      error: "timeout",
      message: "The run did not finish within 50 ms",
      timeoutMs: 50,
      conversationId: json.conversationId,
    });
    assert.equal(typeof json.conversationId, "string");
    assert.equal(seen?.aborted, true);
    assert.ok(Date.now() - started < 50 + 1000);
  });
});

describe("POST /chat: conversations", () => {
  const unknownId = "3f0c1f6e-8d1e-4c43-9c8e-5f0a3b2d9a10";

  it("starts a new conversation and reports no history", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("first answer")) }));

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 200);
    assert.match(json.conversationId, /^[0-9a-f-]{36}$/);
    assert.equal(json.metrics.historyMessages, 0);
  });

  it("answers a follow-up with the same id, the earlier exchange in view, and two history messages", async () => {
    const react = fakeStrategy("react", completed("ALT-001 is firing."));
    const baseUrl = await startServer(settingsFor({ react }));
    const first = await postChat(baseUrl, { message: "which alerts are firing on checkout?", reflect: false });

    const second = await postChat(baseUrl, {
      message: "open an incident for the worst one",
      reflect: false,
      conversationId: first.json.conversationId,
    });

    assert.equal(second.status, 200);
    assert.equal(second.json.conversationId, first.json.conversationId);
    assert.equal(second.json.metrics.historyMessages, 2);
    const input = react.calls[1]?.input ?? "";
    assert.ok(input.includes("User: which alerts are firing on checkout?"));
    assert.ok(input.includes("Assistant: ALT-001 is firing."));
    assert.ok(input.endsWith("open an incident for the worst one"));
  });

  it("replies 404 for an unknown conversation and does not run the agent", async () => {
    const react = fakeStrategy("react", completed("ok"));
    const store = new FakeConversationStore();
    const baseUrl = await startServer(settingsFor({ react }, { conversations: store }));

    const { status, json } = await postChat(baseUrl, { ...validBody, conversationId: unknownId });

    assert.equal(status, 404);
    assert.deepEqual(json, {
      error: "conversation_not_found",
      message: `Conversation not found: ${unknownId}`,
      conversationId: unknownId,
    });
    assert.equal(react.calls.length, 0);
    assert.throws(() => store.lastMessages(unknownId, 12));
  });

  it("replies 400 for a conversationId that is not a UUID", async () => {
    const react = fakeStrategy("react", completed("ok"));
    const baseUrl = await startServer(settingsFor({ react }));

    const { status, json } = await postChat(baseUrl, { ...validBody, conversationId: "abc" });

    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
    assert.deepEqual(json.issues.map((issue: { path: unknown[] }) => issue.path), [["conversationId"]]);
    assert.equal(react.calls.length, 0);
  });

  it("names the new conversation in a 502 and saves nothing in it", async () => {
    const failing = fakeStrategy("react", async () => {
      throw new Error("kaboom");
    });
    const store = new FakeConversationStore();
    const baseUrl = await startServer(settingsFor({ react: failing }, { conversations: store }));

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 502);
    assert.equal(typeof json.conversationId, "string");
    assert.deepEqual(store.lastMessages(json.conversationId, 12), []);
  });

  it("continues a conversation with a different strategy", async () => {
    const react = fakeStrategy("react", completed("from react"));
    const planExecute = fakeStrategy("plan-execute", completed("from plan"));
    const baseUrl = await startServer(settingsFor({ react, "plan-execute": planExecute }));
    const first = await postChat(baseUrl, validBody);

    const second = await postChat(baseUrl, {
      message: "again",
      reflect: false,
      strategy: "plan-execute",
      conversationId: first.json.conversationId,
    });

    assert.equal(second.json.metrics.historyMessages, 2);
    assert.ok((planExecute.calls[0]?.input ?? "").includes("Assistant: from react"));
  });

  it("creates no conversation for an unknown strategy", async () => {
    const created: string[] = [];
    class CountingStore extends FakeConversationStore {
      override create() {
        const conversation = super.create();
        created.push(conversation.id);
        return conversation;
      }
    }
    const baseUrl = await startServer(
      settingsFor({ react: fakeStrategy("react", completed("ok")) }, { conversations: new CountingStore() }),
    );

    const { status } = await postChat(baseUrl, { ...validBody, strategy: "nope" });

    assert.equal(status, 422);
    assert.deepEqual(created, []);
  });
});

describe("POST /chat: memory", () => {
  const QUERY = "who should I page about failed purchases?";
  const FACT = "The payments team owns the checkout service";

  it("reports how many facts were recalled for the user", async () => {
    const memories = new FakeMemoryStore({
      embedder: new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), [FACT]: scoredAgainst(0, 0.6) }),
    });
    await memories.remember("oncall-a", FACT);
    const react = fakeStrategy("react", completed("page payments"));
    const baseUrl = await startServer(settingsFor({ react }, { memories }));

    const { status, json } = await postChat(baseUrl, { message: QUERY, reflect: false, userId: "oncall-a" });

    assert.equal(status, 200);
    assert.equal(json.metrics.recalledMemories, 1);
    assert.match(react.calls[0]!.input, /\[memory 1\] The payments team owns the checkout service/);
  });

  it("answers with the same body shape and learns the fact in the background (SC-006)", async (t) => {
    t.mock.method(console, "log", () => {});
    const LEARNED = "The engineer is on the payments team";
    const memories = new FakeMemoryStore({
      embedder: new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), [LEARNED]: scoredAgainst(0, 0.6) }),
    });
    const background = new BackgroundTasks();
    const react = fakeStrategy("react", completed("page payments"));
    const baseUrl = await startServer(
      settingsFor(
        { react },
        {
          memories,
          background,
          createDependencies: () => ({
            model: new ScriptedChatModel([learningTurn({ hasLearning: true, fact: LEARNED })]),
            tools: [],
          }),
        },
      ),
    );

    const { status, json } = await postChat(baseUrl, { message: QUERY, reflect: false, userId: "oncall-a" });
    await background.settled();

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json).sort(), ["answer", "conversationId", "metrics", "stopReason", "trace"]);
    const { contextBreakdown, ...counts } = json.metrics;
    assert.deepEqual(counts, {
      llmCalls: 2,
      latencyMs: 15,
      historyMessages: 0,
      recalledMemories: 0,
      promptTokens: null,
    });
    // With a userId the memory tools join the (empty) tool list, so the tools source is more than "[]".
    assert.ok(contextBreakdown.tools > 1);
    assert.ok(ChatReply.safeParse(json).success);
    assert.deepEqual(
      (await memories.recall("oncall-a", QUERY)).map((memory) => memory.fact),
      [LEARNED],
    );
  });

  it("rejects a blank userId with 400", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: false, userId: "   " });
    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
  });

  it("answers 500 internal and logs the cause when recall fails", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const memories = new FakeMemoryStore({ embedder: new FakeEmbedder({}, { failing: true }) });
    const react = fakeStrategy("react", completed("ok"));
    const baseUrl = await startServer(settingsFor({ react }, { memories }));

    const { status, json } = await postChat(baseUrl, { message: QUERY, reflect: false, userId: "oncall-a" });

    assert.equal(status, 500);
    assert.deepEqual(json, { error: "internal", message: "Internal server error" });
    assert.deepEqual(react.calls, []);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /^Memory recall failed: Embedding failed: /);
  });
});

describe("POST /chat: history summary", () => {
  const SUMMARY = "- Decision: page the payments team\n- Open: INC-002 stays open";
  const seedConversation = (store: FakeConversationStore, count: number) => {
    const { id } = store.create();
    for (let index = 0; index < count; index++) {
      store.append(id, { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index + 1}` });
    }
    return id;
  };

  it("gives the agent the stored summary ahead of the last 8 messages", async () => {
    const store = new FakeConversationStore();
    const id = seedConversation(store, 16);
    store.saveSummary(id, SUMMARY, 0, 8);
    const react = fakeStrategy("react", completed("ok"));
    const baseUrl = await startServer(settingsFor({ react }, { conversations: store }));

    const { status, json } = await postChat(baseUrl, { ...validBody, conversationId: id });

    assert.equal(status, 200);
    const input = react.calls[0]?.input ?? "";
    assert.ok(input.startsWith("Summary of the earlier conversation"));
    assert.ok(input.includes("page the payments team"));
    assert.ok(input.includes("message 9"));
    assert.ok(!input.includes("message 8\n"));
    assert.equal(json.metrics.historyMessages, 8);
  });

  it("puts a summarize event first in the reply that stored a summary, and not in the next one (US3-AS1, US3-AS2)", async () => {
    const store = new FakeConversationStore();
    const id = seedConversation(store, 16);
    const react = fakeStrategy("react", completed("ok"));
    const model = new ScriptedChatModel([textTurn(SUMMARY), NO_LEARNING]);
    const baseUrl = await startServer(
      settingsFor({ react }, { conversations: store, createDependencies: () => ({ model, tools: [] }) }),
    );

    const first = await postChat(baseUrl, { ...validBody, conversationId: id });

    assert.equal(first.status, 200);
    const parsed = ChatReply.parse(first.json);
    assert.equal(parsed.trace[0]?.type, "summarize");
    assert.equal(parsed.trace[0]?.type === "summarize" ? parsed.trace[0].absorbed : undefined, 8);
    assert.equal(parsed.metrics.historyMessages, 8);
    assert.equal(parsed.metrics.llmCalls, 2 + 1);

    const second = await postChat(baseUrl, { ...validBody, conversationId: id });

    assert.equal(second.status, 200);
    assert.ok(ChatReply.parse(second.json).trace.every((event) => event.type !== "summarize"));
    assert.equal(model.calls, 1);
  });

  it("replies 200 with no event when the summarizer fails, and still gives the newest 14 messages (US3-AS3)", async () => {
    const store = new FakeConversationStore();
    const id = seedConversation(store, 16);
    const react = fakeStrategy("react", completed("ok"));
    const model = new ScriptedChatModel([new Error("provider down")]);
    const baseUrl = await startServer(
      settingsFor({ react }, { conversations: store, createDependencies: () => ({ model, tools: [] }) }),
    );

    const { status, json } = await postChat(baseUrl, { ...validBody, conversationId: id });

    assert.equal(status, 200);
    const parsed = ChatReply.parse(json);
    assert.ok(parsed.trace.every((event) => event.type !== "summarize"));
    assert.equal(parsed.metrics.historyMessages, 14);
    assert.equal(store.summaryOf(id), undefined);
  });

  it("keeps the summarize event first in the 502 of a run that fails after the summary was stored (G1, FR-009)", async () => {
    const store = new FakeConversationStore();
    const id = seedConversation(store, 16);
    let failing = true;
    const react = fakeStrategy("react", async () =>
      failing
        ? {
            stopReason: "error" as const,
            answer: null,
            error: { name: "Error", message: "tool failed" },
            trace: [{ type: "answer" as const, content: "partial" }],
            metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null },
          }
        : completed("ok"),
    );
    const model = new ScriptedChatModel([textTurn(SUMMARY), NO_LEARNING]);
    const baseUrl = await startServer(
      settingsFor({ react }, { conversations: store, createDependencies: () => ({ model, tools: [] }) }),
    );

    const failed = await postChat(baseUrl, { ...validBody, conversationId: id });

    assert.equal(failed.status, 502);
    const error = ErrorReply.parse(failed.json);
    assert.ok(error.error === "run_failed");
    assert.equal(error.trace?.[0]?.type, "summarize");

    failing = false;
    const next = await postChat(baseUrl, { ...validBody, conversationId: id });
    assert.equal(next.status, 200);
    assert.ok((react.calls[1]?.input ?? "").startsWith("Summary of the earlier conversation"));
    assert.equal(model.calls, 1);
  });
});
