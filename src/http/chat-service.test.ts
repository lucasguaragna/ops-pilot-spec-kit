import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConversationNotFoundError, EmbeddingError, UnknownStrategyError } from "../domain/errors.ts";
import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy, RunResult } from "../domain/types.ts";
import { FakeConversationStore } from "../testing/fake-conversation-store.ts";
import { composeInput, historyBlock } from "../agents/history.ts";
import { renderSummary, summaryMessages } from "../agents/history-summarizer.ts";
import { composeMemoryInput, memoryBlock } from "../agents/memories.ts";
import { createReactStrategy } from "../agents/react.ts";
import { createTools } from "../agents/tools.ts";
import { toolDefinitionsText } from "../context/breakdown.ts";
import { estimateTokens } from "../context/tokens.ts";
import { createStore } from "../store/in-memory-store.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { FakeMemoryStore } from "../testing/fake-memory-store.ts";
import { learningTurn, NO_LEARNING } from "../testing/learning-turns.ts";
import {
  hangingTurn,
  ScriptedChatModel,
  textTurn,
  toolCallTurn,
  withUsage,
  type ScriptedTurn,
} from "../testing/scripted-chat-model.ts";
import { SqliteConversationStore } from "../store/sqlite-conversation-store.ts";
import type { BaseMessage } from "@langchain/core/messages";
import { BackgroundTasks } from "./background-tasks.ts";
import type { ChatOutcome } from "./chat-reply.ts";
import { runChat, runWithTimeout } from "./chat-service.ts";
import type { ChatRequest } from "./schemas.ts";
import { resolveSettings, type AppSettings } from "./server.ts";

describe("runWithTimeout", () => {
  it("resolves done with the value when the run finishes first", async () => {
    const outcome = await runWithTimeout(async () => "value", 1000);
    assert.deepEqual(outcome, { kind: "done", value: "value" });
  });

  it("resolves timeout and aborts the signal when the run never finishes", async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();

    const outcome = await runWithTimeout((signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    }, 30);

    assert.deepEqual(outcome, { kind: "timeout" });
    assert.equal(seen?.aborted, true);
    assert.ok(Date.now() - started >= 25);
  });

  it("resolves thrown when the run rejects", async () => {
    const error = new Error("boom");
    const outcome = await runWithTimeout(async () => {
      throw error;
    }, 1000);
    assert.deepEqual(outcome, { kind: "thrown", error });
  });

  it("clears the timer, so a finished run does not keep the process alive", async () => {
    const originalClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared += 1;
      originalClear(handle);
    }) as typeof clearTimeout;
    try {
      await runWithTimeout(async () => 1, 60_000);
    } finally {
      globalThis.clearTimeout = originalClear;
    }
    assert.equal(cleared, 1);
  });
});

const completed = (answer: string): RunResult => ({
  stopReason: "completed",
  answer,
  trace: [],
  metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null },
});

function recordingStrategy(run: () => Promise<RunResult>): ReasoningStrategy & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    name: "react",
    inputs,
    async run(input) {
      inputs.push(input);
      return run();
    },
  };
}

function serviceSettings(strategy: ReasoningStrategy, conversations: FakeConversationStore, extra: Partial<AppSettings> = {}) {
  return resolveSettings({
    registry: { react: () => strategy },
    // The fake strategies never call the model; only the learning step does, and it learns nothing.
    createDependencies: () => ({ model: new ScriptedChatModel([NO_LEARNING]), tools: [] }),
    conversations,
    memories: new FakeMemoryStore({ embedder: new FakeEmbedder() }),
    ...extra,
  });
}

const request = (message: string, conversationId?: string): ChatRequest => ({
  message,
  strategy: "react",
  reflect: false,
  ...(conversationId === undefined ? {} : { conversationId }),
});

const seed = (store: FakeConversationStore, messages: NewMessage[]) => {
  const { id } = store.create();
  for (const message of messages) store.append(id, message);
  return id;
};

describe("runChat: conversation", () => {
  it("creates a conversation when the request has no id, and uses no history", async () => {
    const store = new FakeConversationStore();
    const strategy = recordingStrategy(async () => completed("hello"));

    const outcome = await runChat(serviceSettings(strategy, store), request("hi"));

    assert.equal(outcome.conversation.historyMessages, 0);
    assert.deepEqual(
      store.lastMessages(outcome.conversation.id, 12).map((message) => [message.role, message.content]),
      [
        ["user", "hi"],
        ["assistant", "hello"],
      ],
    );
    assert.deepEqual(strategy.inputs, ["hi"]);
  });

  it("gives the agent the earlier exchange ahead of the new message and keeps the id", async () => {
    const store = new FakeConversationStore();
    const id = seed(store, [
      { role: "user", content: "which alerts are firing on checkout?" },
      { role: "assistant", content: "ALT-001 is firing." },
    ]);
    const strategy = recordingStrategy(async () => completed("done"));

    const outcome = await runChat(serviceSettings(strategy, store), request("open an incident for the worst one", id));

    assert.deepEqual(outcome.conversation, { id, historyMessages: 2 });
    const input = strategy.inputs[0] ?? "";
    assert.ok(input.includes("User: which alerts are firing on checkout?"));
    assert.ok(input.includes("Assistant: ALT-001 is firing."));
    assert.ok(input.endsWith("open an incident for the worst one"));
    assert.ok(input.indexOf("ALT-001") < input.indexOf("open an incident"));
    assert.equal(store.lastMessages(id, 12).length, 4);
  });

  it("gives at most the 14 newest word for word, oldest first, before any summary", async () => {
    const store = new FakeConversationStore();
    const id = seed(
      store,
      Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `msg-${String(index + 1).padStart(2, "0")}`,
      })),
    );
    const strategy = recordingStrategy(async () => completed("ok"));

    const outcome = await runChat(serviceSettings(strategy, store), request("next", id));

    const input = strategy.inputs[0] ?? "";
    assert.equal(outcome.conversation.historyMessages, 14);
    assert.ok(!input.includes("msg-06"));
    assert.ok(input.includes("msg-07"));
    assert.ok(input.indexOf("msg-07") < input.indexOf("msg-20"));
  });

  it("uses every message when there are fewer than the limit", async () => {
    const store = new FakeConversationStore();
    const id = seed(store, Array.from({ length: 5 }, (_, index) => ({ role: "user" as const, content: `m${index}` })));
    const outcome = await runChat(serviceSettings(recordingStrategy(async () => completed("ok")), store), request("next", id));
    assert.equal(outcome.conversation.historyMessages, 5);
  });

  const unsaved: [string, () => Promise<RunResult>, Partial<AppSettings>][] = [
    [
      "a run that ends at the iteration limit",
      async () => ({ stopReason: "iteration_limit", answer: null, trace: [], metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null } }),
      {},
    ],
    [
      "a run that returns an error",
      async () => ({
        stopReason: "error",
        answer: null,
        error: { name: "Error", message: "x" },
        trace: [],
        metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null },
      }),
      {},
    ],
    [
      "a run that throws",
      async () => {
        throw new Error("boom");
      },
      {},
    ],
    ["a run that times out", () => new Promise<RunResult>(() => {}), { timeoutMs: 20 }],
  ];
  for (const [label, run, extra] of unsaved) {
    it(`saves nothing for ${label}, but still names the new conversation`, async () => {
      const store = new FakeConversationStore();
      const outcome = await runChat(serviceSettings(recordingStrategy(run), store, extra), request("hi"));
      assert.equal(outcome.conversation.historyMessages, 0);
      assert.deepEqual(store.lastMessages(outcome.conversation.id, 12), []);
    });
  }

  it("creates no conversation for an unknown strategy", async () => {
    const created: string[] = [];
    class CountingStore extends FakeConversationStore {
      override create() {
        const conversation = super.create();
        created.push(conversation.id);
        return conversation;
      }
    }
    const settings = serviceSettings(recordingStrategy(async () => completed("ok")), new CountingStore());

    await assert.rejects(runChat(settings, { ...request("hi"), strategy: "nope" }), UnknownStrategyError);
    assert.deepEqual(created, []);
  });

  it("rejects an unknown conversation id without running the agent", async () => {
    const strategy = recordingStrategy(async () => completed("ok"));
    const settings = serviceSettings(strategy, new FakeConversationStore());

    await assert.rejects(runChat(settings, request("hi", "missing")), (error: unknown) => {
      return error instanceof ConversationNotFoundError && error.conversationId === "missing";
    });
    assert.deepEqual(strategy.inputs, []);
  });
});

const SUMMARY_TEXT = "- Decision: page the payments team\n- checkout-api runs on eu-west\n- Open: INC-002 stays open";

/** `count` alternating messages m1, m2, ... */
const conversationOf = (count: number): NewMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `m${index + 1}`,
  }));

describe("runChat: summary in context", () => {
  it("gives the stored summary, then the last 8 messages, then the request (US1-AS1)", async () => {
    const store = new FakeConversationStore();
    const messages = conversationOf(16);
    const id = seed(store, messages);
    store.saveSummary(id, SUMMARY_TEXT, 0, 8);
    const strategy = recordingStrategy(async () => completed("ok"));

    const outcome = await runChat(serviceSettings(strategy, store), request("next", id));

    const rendered = renderSummary(SUMMARY_TEXT);
    assert.equal(strategy.inputs[0], rendered + historyBlock(messages.slice(8)) + "next");
    assert.equal(outcome.conversation.historyMessages, 8);
    assert.equal(outcome.context.history, estimateTokens(historyBlock(messages.slice(8), rendered)));
  });

  it("leaves the input byte-identical when there is no summary and 8 or fewer earlier messages (US1-AS2)", async () => {
    const store = new FakeConversationStore();
    const messages = conversationOf(6);
    const id = seed(store, messages);
    const strategy = recordingStrategy(async () => completed("ok"));

    await runChat(serviceSettings(strategy, store), request("next", id));

    assert.equal(strategy.inputs[0], composeInput(messages, "next"));
  });

  it("gives all 14 uncovered messages word for word when no summary exists yet", async () => {
    const store = new FakeConversationStore();
    const messages = conversationOf(14);
    const id = seed(store, messages);
    const strategy = recordingStrategy(async () => completed("ok"));

    const outcome = await runChat(serviceSettings(strategy, store), request("next", id));

    assert.equal(outcome.conversation.historyMessages, 14);
    assert.equal(strategy.inputs[0], composeInput(messages, "next"));
  });

  it("puts the user's remembered facts first, then the summary, then the messages (US1-AS4)", async () => {
    const QUERY = "who should I page?";
    const FACT = "The payments team owns the checkout service";
    const embedder = new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), [FACT]: scoredAgainst(0, 0.6) });
    const memories = new FakeMemoryStore({ embedder });
    await memories.remember("oncall-a", FACT);
    const store = new FakeConversationStore();
    const messages = conversationOf(16);
    const id = seed(store, messages);
    store.saveSummary(id, SUMMARY_TEXT, 0, 8);
    const strategy = recordingStrategy(async () => completed("ok"));

    await runChat(serviceSettings(strategy, store, { memories }), { ...request(QUERY, id), userId: "oncall-a" });

    const expected =
      memoryBlock([{ id: 1, fact: FACT }]) + renderSummary(SUMMARY_TEXT) + historyBlock(messages.slice(8)) + QUERY;
    assert.equal(strategy.inputs[0], expected);
  });
});

describe("runChat: summarization", () => {
  const DECISION = "- Decision: page the payments team";
  const summary = (open: string): string => `${DECISION}\n- checkout-api runs on eu-west\n- Open: ${open}`;
  const SUMMARY_1 = summary("INC-001, INC-002");
  const SUMMARY_2 = summary("INC-002, INC-003");
  const SUMMARY_3 = summary("INC-003");
  const summaryTurn = (text: string, inputTokens?: number): ScriptedTurn => {
    const turn = textTurn(text);
    return inputTokens === undefined ? turn : withUsage(turn, inputTokens);
  };

  /** The messages of the first `exchanges` exchanges: q1, a1, q2, a2, ... */
  const earlier = (exchanges: number): NewMessage[] =>
    Array.from({ length: exchanges * 2 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index % 2 === 0 ? "q" : "a"}${Math.floor(index / 2) + 1}`,
    }));

  /** A strategy that answers a1, a2, ... and keeps every input. */
  function answering(): ReasoningStrategy & { inputs: string[] } {
    const inputs: string[] = [];
    return {
      name: "react",
      inputs,
      async run(input) {
        inputs.push(input);
        return completed(`a${inputs.length}`);
      },
    };
  }

  /** Settings over a scripted model that answers the summarizer, and every prompt it was sent. */
  function summarizing(turns: readonly ScriptedTurn[], extra: Partial<AppSettings> = {}, strategy: ReasoningStrategy = answering()) {
    const model = new ScriptedChatModel(turns);
    const prompts: BaseMessage[][] = [];
    model.callbacks = [
      {
        handleChatModelStart: (_llm: unknown, batch: BaseMessage[][]) => {
          prompts.push(...batch);
        },
      },
    ];
    const store = (extra.conversations as FakeConversationStore | undefined) ?? new FakeConversationStore();
    const settings = resolveSettings({
      registry: { react: () => strategy },
      createDependencies: () => ({ model, tools: [] }),
      conversations: store,
      memories: new FakeMemoryStore({ embedder: new FakeEmbedder() }),
      ...extra,
    });
    return { settings, model, prompts, store, strategy: strategy as ReasoningStrategy & { inputs: string[] } };
  }

  /** Runs `count` exchanges in one conversation; returns every outcome and the model's call count after each. */
  async function drive(settings: ReturnType<typeof resolveSettings>, model: ScriptedChatModel, count: number) {
    const outcomes: ChatOutcome[] = [];
    const callsAfter: number[] = [];
    let id: string | undefined;
    for (let n = 1; n <= count; n++) {
      const outcome = await runChat(settings, request(`q${n}`, id));
      id = outcome.conversation.id;
      outcomes.push(outcome);
      callsAfter.push(model.calls);
    }
    return { outcomes, callsAfter, id: id as string };
  }

  it("summarizes only on exchanges 9, 13, and 17 over 20 exchanges (SC-002)", async () => {
    const { settings, model, store } = summarizing([summaryTurn(SUMMARY_1), summaryTurn(SUMMARY_2), summaryTurn(SUMMARY_3)]);

    const { callsAfter, id } = await drive(settings, model, 20);

    const callingExchanges = callsAfter.flatMap((calls, index) => (calls > (callsAfter[index - 1] ?? 0) ? [index + 1] : []));
    assert.deepEqual(callingExchanges, [9, 13, 17]);
    assert.equal(model.calls, 3);
    assert.equal(store.summaryOf(id)?.coveredMessages, 24);
  });

  it("gives each call the previous summary and exactly the messages to absorb", async () => {
    const { settings, model, prompts } = summarizing([summaryTurn(SUMMARY_1), summaryTurn(SUMMARY_2), summaryTurn(SUMMARY_3)]);

    await drive(settings, model, 17);

    const all = earlier(20);
    assert.equal(prompts.length, 3);
    const humanText = (index: number) => String(prompts[index]?.[1]?.content);
    assert.equal(humanText(0), String(summaryMessages(undefined, all.slice(0, 8))[1]?.content));
    assert.equal(humanText(1), String(summaryMessages(SUMMARY_1, all.slice(8, 16))[1]?.content));
    assert.equal(humanText(2), String(summaryMessages(SUMMARY_2, all.slice(16, 24))[1]?.content));
    assert.match(humanText(0), /^Previous summary:\n\(none\)\n\n/);
  });

  it("stores coverage 8, then 16, then 24, with the text the model returned (merge)", async () => {
    const { settings, model, store } = summarizing([summaryTurn(SUMMARY_1), summaryTurn(SUMMARY_2), summaryTurn(SUMMARY_3)]);
    let id: string | undefined;
    const seen: { covered: number | undefined; summary: string | undefined }[] = [];
    for (let n = 1; n <= 17; n++) {
      id = (await runChat(settings, request(`q${n}`, id))).conversation.id;
      if (n === 9 || n === 13 || n === 17) {
        const stored = store.summaryOf(id);
        seen.push({ covered: stored?.coveredMessages, summary: stored?.summary });
      }
    }
    assert.deepEqual(seen, [
      { covered: 8, summary: SUMMARY_1 },
      { covered: 16, summary: SUMMARY_2 },
      { covered: 24, summary: SUMMARY_3 },
    ]);
    assert.ok(model.calls === 3);
  });

  it("gives exchange 9's agent the new summary and only the last 8 messages", async () => {
    const { settings, model, strategy } = summarizing([summaryTurn(SUMMARY_1)]);

    await drive(settings, model, 9);

    assert.equal(strategy.inputs[8], renderSummary(SUMMARY_1) + historyBlock(earlier(8).slice(8)) + "q9");
  });

  it("does not summarize below the threshold: 14 uncovered messages, no call, nothing stored (US2-AS1)", async () => {
    const store = new FakeConversationStore();
    const id = seed(store, earlier(7));
    const { settings, model } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store });

    await runChat(settings, request("q8", id));

    assert.equal(model.calls, 0);
    assert.equal(store.summaryOf(id), undefined);
  });

  describe("failures", () => {
    it("thrown: the reply is the agent's, the 14 newest go word for word, and the retry waits for exchange 13 (US3-AS3, C1)", async () => {
      const { settings, model, store, strategy, prompts } = summarizing([new Error("provider down"), summaryTurn(SUMMARY_1)]);

      const { outcomes, callsAfter, id } = await drive(settings, model, 13);

      const ninth = outcomes[8];
      assert.ok(ninth?.kind === "result" && ninth.result.stopReason === "completed" && ninth.result.answer === "a9");
      assert.equal(strategy.inputs[8], historyBlock(earlier(8).slice(-14)) + "q9");
      assert.equal(ninth?.conversation.historyMessages, 14);
      // Exchanges 10, 11, and 12 make no call; exchange 13 tries again and absorbs all 16 outside the window.
      assert.deepEqual(callsAfter.slice(8, 13), [1, 1, 1, 1, 2]);
      assert.equal(store.summaryOf(id)?.coveredMessages, 16);
      assert.equal(String(prompts[1]?.[1]?.content), String(summaryMessages(undefined, earlier(12).slice(0, 16))[1]?.content));
    });

    it("every attempt fails: 1 call on each of exchanges 9, 13, and 17, and the context never exceeds 14 (SC-002, SC-003)", async () => {
      const { settings, model, store } = summarizing([new Error("provider down")]);

      const { outcomes, id } = await drive(settings, model, 20);

      assert.equal(model.calls, 3);
      assert.ok(outcomes.every((outcome) => outcome.kind === "result"));
      assert.ok(outcomes.every((outcome) => outcome.conversation.historyMessages <= 14));
      assert.equal(store.summaryOf(id), undefined);
    });

    it("timeout: the run goes on, the call is counted, and nothing is stored", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings, model } = summarizing([hangingTurn()], { conversations: store, summaryTimeoutMs: 20 });

      const outcome = await runChat(settings, request("q9", id));

      assert.ok(outcome.kind === "result" && outcome.result.stopReason === "completed");
      assert.equal(model.calls, 1);
      assert.equal(outcome.kind === "result" ? outcome.result.metrics.llmCalls : -1, 1 + 1);
      assert.equal(store.summaryOf(id), undefined);
      assert.equal(outcome.conversation.historyMessages, 14);
    });

    it("empty: a blank reply is a failure that stores nothing", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([summaryTurn("  \n ")], { conversations: store });

      const outcome = await runChat(settings, request("q9", id));

      assert.equal(store.summaryOf(id), undefined);
      assert.equal(outcome.conversation.historyMessages, 14);
    });

    it("empty: only secret lines is a failure that stores nothing", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing(
        [summaryTurn("- The staging DB password is hunter2\n- api_key=abc123")],
        { conversations: store },
      );

      await runChat(settings, request("q9", id));

      assert.equal(store.summaryOf(id), undefined);
    });

    it("conflict: a lost compare-and-swap keeps the previous summary for the agent", async () => {
      class LosingStore extends FakeConversationStore {
        override saveSummary(): boolean {
          return false;
        }
      }
      const store = new LosingStore();
      const id = seed(store, earlier(12));
      FakeConversationStore.prototype.saveSummary.call(store, id, SUMMARY_1, 0, 8);
      const { settings, strategy } = summarizing([summaryTurn(SUMMARY_3)], { conversations: store });

      await runChat(settings, request("q13", id));

      const input = strategy.inputs[0] ?? "";
      assert.ok(input.startsWith(renderSummary(SUMMARY_1)));
      assert.ok(!input.includes("INC-003"));
    });

    it("a store that throws on save is a failure, not a thrown request", async () => {
      class BrokenStore extends FakeConversationStore {
        override saveSummary(): boolean {
          throw new Error("disk full");
        }
      }
      const store = new BrokenStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store });

      const outcome = await runChat(settings, request("q9", id));

      assert.equal(outcome.kind, "result");
    });

    it("recall failure: throws before any summarization call", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const memories = new FakeMemoryStore({ embedder: new FakeEmbedder({}, { failing: true }) });
      const { settings, model } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store, memories });

      await assert.rejects(runChat(settings, { ...request("q9", id), userId: "oncall-a" }), EmbeddingError);
      assert.equal(model.calls, 0);
    });
  });

  describe("a run that fails after the summary was stored (G1)", () => {
    const errorResult = (): RunResult => ({
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "tool failed" },
      trace: [{ type: "answer", content: "partial" }],
      metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null },
    });

    it("keeps the stored summary, puts the event first in the trace, and uses the summary on the next request", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      let failing = true;
      const strategy = recordingStrategy(async () => (failing ? errorResult() : completed("ok")));
      const { settings } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store }, strategy);

      const first = await runChat(settings, request("q9", id));

      assert.ok(first.kind === "result" && first.result.stopReason === "error");
      assert.equal(first.kind === "result" ? first.result.trace[0]?.type : undefined, "summarize");
      assert.equal(store.summaryOf(id)?.coveredMessages, 8);

      failing = false;
      await runChat(settings, request("q9 again", id));
      assert.ok((strategy.inputs[1] ?? "").startsWith(renderSummary(SUMMARY_1)));
    });

    it("keeps the stored summary when the run times out (504)", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const strategy = recordingStrategy(() => new Promise<RunResult>(() => {}));
      const { settings } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store, timeoutMs: 20 }, strategy);

      const outcome = await runChat(settings, request("q9", id));

      assert.equal(outcome.kind, "timeout");
      assert.equal(store.summaryOf(id)?.coveredMessages, 8);
    });
  });

  it("keeps an early decision in the agent's context at exchange 20 (G2, SC-001)", async () => {
    const { settings, model, strategy } = summarizing([summaryTurn(SUMMARY_1), summaryTurn(SUMMARY_2), summaryTurn(SUMMARY_3)]);

    await drive(settings, model, 20);

    const input = strategy.inputs[19] ?? "";
    assert.ok(input.startsWith(renderSummary(SUMMARY_3)));
    assert.ok(input.includes(DECISION));
    // The message that stated it left the verbatim messages long ago.
    assert.ok(!input.includes("User: q1\n"));
  });

  describe("metrics", () => {
    it("adds a stored step's calls and tokens to the reply's metrics", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([summaryTurn(SUMMARY_1, 120)], { conversations: store });

      const outcome = await runChat(settings, request("q9", id));

      assert.ok(outcome.kind === "result");
      assert.equal(outcome.result.metrics.llmCalls, 1 + 1);
      assert.equal(outcome.result.metrics.promptTokens, 120);
    });

    it("counts the calls and tokens of a failed step too", async () => {
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([summaryTurn("", 50)], { conversations: store });

      const outcome = await runChat(settings, request("q9", id));

      assert.ok(outcome.kind === "result");
      assert.equal(outcome.result.metrics.llmCalls, 1 + 1);
      assert.equal(outcome.result.metrics.promptTokens, 50);
    });
  });

  describe("log lines", () => {
    it("writes one log line for the request that summarized, with no item text", async (t) => {
      const log = t.mock.method(console, "log", () => {});
      const warn = t.mock.method(console, "warn", () => {});
      const error = t.mock.method(console, "error", () => {});
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store });

      await runChat(settings, request("q9", id));

      assert.equal(log.mock.callCount(), 1);
      assert.match(String(log.mock.calls[0]?.arguments[0]), new RegExp(`^Summarized 8 messages for conversation ${id}$`));
      assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
      assert.doesNotMatch(String(log.mock.calls[0]?.arguments[0]), /payments|INC-001/);
    });

    it("writes one error line for a failed summarization", async (t) => {
      const log = t.mock.method(console, "log", () => {});
      const error = t.mock.method(console, "error", () => {});
      const store = new FakeConversationStore();
      const id = seed(store, earlier(8));
      const { settings } = summarizing([new Error("provider down")], { conversations: store });

      await runChat(settings, request("q9", id));

      assert.equal(log.mock.callCount(), 0);
      assert.equal(error.mock.callCount(), 1);
      assert.equal(String(error.mock.calls[0]?.arguments[0]), `Summary failed for conversation ${id}: Error: provider down`);
    });

    it("writes nothing below the threshold", async (t) => {
      const log = t.mock.method(console, "log", () => {});
      const warn = t.mock.method(console, "warn", () => {});
      const error = t.mock.method(console, "error", () => {});
      const store = new FakeConversationStore();
      const id = seed(store, earlier(4));
      const { settings } = summarizing([summaryTurn(SUMMARY_1)], { conversations: store });

      await runChat(settings, request("q5", id));

      assert.equal(log.mock.callCount() + warn.mock.callCount() + error.mock.callCount(), 0);
    });
  });

  describe("restart (SC-005)", () => {
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("makes no summarization call after a restart and still gives the agent the stored summary", async () => {
      const dir = mkdtempSync(join(tmpdir(), "opspilot-summary-"));
      dirs.push(dir);
      const path = join(dir, "test.db");

      const first = new SqliteConversationStore(path);
      const id = seed(first as unknown as FakeConversationStore, earlier(8));
      const run = summarizing([summaryTurn(SUMMARY_1)], { conversations: first as unknown as FakeConversationStore });
      await runChat(run.settings, request("q9", id));
      assert.equal(run.model.calls, 1);
      first.close();

      const second = new SqliteConversationStore(path);
      try {
        const again = summarizing([summaryTurn(SUMMARY_2)], { conversations: second as unknown as FakeConversationStore });
        await runChat(again.settings, request("q10", id));
        assert.equal(again.model.calls, 0);
        assert.ok((again.strategy.inputs[0] ?? "").startsWith(renderSummary(SUMMARY_1)));
      } finally {
        second.close();
      }
    });
  });
});

describe("runChat: memory", () => {
  const QUERY = "who should I page about failed purchases?";
  const FACT = "The payments team owns the checkout service";

  async function seededMemories(options: { failing?: boolean } = {}) {
    const embedder = new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), [FACT]: scoredAgainst(0, 0.6) }, options);
    const store = new FakeMemoryStore({ embedder });
    if (!options.failing) await store.remember("oncall-a", FACT);
    return { store, embedder };
  }

  const withUser = (message: string, userId?: string): ChatRequest => ({
    ...request(message),
    ...(userId === undefined ? {} : { userId }),
  });

  it("puts the user's recalled facts ahead of the message and counts them", async () => {
    const { store } = await seededMemories();
    const strategy = recordingStrategy(async () => completed("page payments"));

    const outcome = await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories: store }), withUser(QUERY, "oncall-a"));

    assert.equal(outcome.recalledMemories, 1);
    assert.equal(strategy.inputs[0], composeMemoryInput([{ id: 1, fact: FACT }], QUERY));
  });

  it("without a userId, never embeds and leaves the input exactly as before", async () => {
    const { store, embedder } = await seededMemories();
    const before = embedder.calls.length;
    const strategy = recordingStrategy(async () => completed("ok"));

    const outcome = await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories: store }), withUser(QUERY));

    assert.equal(outcome.recalledMemories, 0);
    assert.equal(strategy.inputs[0], QUERY);
    assert.equal(embedder.calls.length, before);
  });

  it("recalls nothing for another user", async () => {
    const { store } = await seededMemories();
    const strategy = recordingStrategy(async () => completed("ok"));
    const outcome = await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories: store }), withUser(QUERY, "oncall-b"));
    assert.equal(outcome.recalledMemories, 0);
    assert.equal(strategy.inputs[0], QUERY);
  });

  it("rejects an unknown conversation before embedding anything", async () => {
    const { store, embedder } = await seededMemories();
    const before = embedder.calls.length;
    const settings = serviceSettings(recordingStrategy(async () => completed("ok")), new FakeConversationStore(), { memories: store });

    await assert.rejects(runChat(settings, { ...withUser(QUERY, "oncall-a"), conversationId: "missing" }), ConversationNotFoundError);
    assert.equal(embedder.calls.length, before);
  });

  it("when recall fails, throws EmbeddingError, creates no conversation, and does not run the agent", async () => {
    const { store } = await seededMemories({ failing: true });
    const created: string[] = [];
    class CountingStore extends FakeConversationStore {
      override create() {
        const conversation = super.create();
        created.push(conversation.id);
        return conversation;
      }
    }
    const strategy = recordingStrategy(async () => completed("ok"));

    await assert.rejects(runChat(serviceSettings(strategy, new CountingStore(), { memories: store }), withUser(QUERY, "oncall-a")), EmbeddingError);
    assert.deepEqual(created, []);
    assert.deepEqual(strategy.inputs, []);
  });

  it("does not show a fact remembered during the run in that same run's input", async () => {
    const { store } = await seededMemories();
    const strategy = recordingStrategy(async () => {
      await store.remember("oncall-a", FACT);
      return completed("ok");
    });
    await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories: store }), withUser(QUERY, "oncall-a"));
    assert.equal(strategy.inputs[0], composeMemoryInput([{ id: 1, fact: FACT }], QUERY));
  });
});

describe("runChat: memory tools", () => {
  async function toolNamesFor(userId?: string): Promise<string[]> {
    let seen: string[] = [];
    const strategy = recordingStrategy(async () => completed("ok"));
    const settings = serviceSettings(strategy, new FakeConversationStore(), {
      registry: {
        react: (dependencies) => {
          seen = dependencies.tools.map((tool) => tool.name);
          return strategy;
        },
      },
      memories: new FakeMemoryStore({ embedder: new FakeEmbedder({ hi: unitVector({ 0: 1 }) }) }),
    });
    await runChat(settings, { ...request("hi"), ...(userId === undefined ? {} : { userId }) });
    return seen;
  }

  it("offers remember_fact only when the request has a userId", async () => {
    assert.ok((await toolNamesFor("oncall-a")).includes("remember_fact"));
    assert.equal((await toolNamesFor()).includes("remember_fact"), false);
  });

  it("offers all three memory tools with a userId and none without (FR-010)", async () => {
    const memoryTools = ["remember_fact", "forget_fact", "forget_preference"];
    const withUser = await toolNamesFor("oncall-a");
    const without = await toolNamesFor();
    for (const name of memoryTools) {
      assert.ok(withUser.includes(name), name);
      assert.equal(without.includes(name), false, name);
    }
  });
});

describe("runChat: learning step", () => {
  const USER = "oncall-a";
  const MESSAGE = "I'm on the payments team, so checkout alerts are mine. Which are firing?";
  const LATER = "Which alerts should I look at first?";
  const FACT = "The engineer is on the payments team and owns the checkout alerts";
  const learns = learningTurn({ hasLearning: true, fact: FACT });

  /** A store whose remember waits until the test opens the gate. */
  class GatedMemoryStore extends FakeMemoryStore {
    open!: () => void;
    private readonly gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    override async remember(userId: string, fact: string) {
      await this.gate;
      return super.remember(userId, fact);
    }
  }

  const embedder = () =>
    new FakeEmbedder({ [MESSAGE]: unitVector({ 1: 1 }), [LATER]: scoredAgainst(0, 0.6), [FACT]: unitVector({ 0: 1 }) });

  /**
   * Settings whose every request gets a model scripted with `turns`. The fake strategy never calls
   * the model, so the learning step reads the first turn.
   */
  function learningSettings(
    turns: readonly ScriptedTurn[],
    options: { run?: () => Promise<RunResult>; memories?: FakeMemoryStore; extra?: Partial<AppSettings> } = {},
  ) {
    const background = new BackgroundTasks();
    const memories = options.memories ?? new FakeMemoryStore({ embedder: embedder() });
    const conversations = new FakeConversationStore();
    const strategy = recordingStrategy(options.run ?? (async () => completed("checkout-latency is firing")));
    const models: ScriptedChatModel[] = [];
    const settings = serviceSettings(strategy, conversations, {
      background,
      memories,
      createDependencies: () => {
        const model = new ScriptedChatModel(turns);
        models.push(model);
        return { model, tools: [] };
      },
      ...options.extra,
    });
    return { settings, background, memories, conversations, strategy, models };
  }

  const withUser = (message: string, userId?: string): ChatRequest => ({
    ...request(message),
    ...(userId === undefined ? {} : { userId }),
  });

  /**
   * An outcome without its conversation id (a fresh UUID in every store) and without latency, which
   * the graph measures on the clock.
   */
  const comparable = ({ conversation, ...rest }: ChatOutcome) => ({
    ...rest,
    result: rest.kind === "result" ? { ...rest.result, metrics: { ...rest.result.metrics, latencyMs: 0 } } : undefined,
    historyMessages: conversation.historyMessages,
  });

  const facts = async (memories: FakeMemoryStore) =>
    (await memories.recall(USER, LATER)).map((memory) => memory.fact);

  it("saves the fact after the step settles and logs it", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    const { settings, background, memories } = learningSettings([learns]);

    await runChat(settings, withUser(MESSAGE, USER));
    await background.settled();

    assert.deepEqual(await facts(memories), [FACT]);
    assert.deepEqual(log.mock.calls.map((call) => call.arguments[0]), [`Learned [memory 1] for ${USER}`]);
  });

  it("recalls the learned fact in a later conversation (SC-001)", async (t) => {
    t.mock.method(console, "log", () => {});
    const { settings, background, strategy } = learningSettings([learns]);
    await runChat(settings, withUser(MESSAGE, USER));
    await background.settled();

    const later = await runChat(settings, withUser(LATER, USER));

    assert.equal(later.recalledMemories, 1);
    assert.match(strategy.inputs[1]!, new RegExp(FACT));
  });

  it("returns the reply while the step is still pending (SC-003)", async (t) => {
    t.mock.method(console, "log", () => {});
    const memories = new GatedMemoryStore({ embedder: embedder() });
    const { settings, background } = learningSettings([learns], { memories });

    const outcome = await runChat(settings, withUser(MESSAGE, USER));

    assert.equal(outcome.kind, "result");
    assert.equal(background.pending, 1);
    assert.deepEqual(await facts(memories), []);

    memories.open();
    await background.settled();
    assert.deepEqual(await facts(memories), [FACT]);
  });

  it("leaves the reply and metrics as they are without the step (FR-007)", async (t) => {
    t.mock.method(console, "log", () => {});
    const learning = learningSettings([learns]);
    const quiet = learningSettings([NO_LEARNING]);

    const withStep = await runChat(learning.settings, withUser(MESSAGE, USER));
    const without = await runChat(quiet.settings, withUser(MESSAGE, USER));
    await Promise.all([learning.background.settled(), quiet.background.settled()]);

    assert.deepEqual(comparable(withStep), comparable(without));
  });

  it("runs no step without a userId", async () => {
    const { settings, background, models } = learningSettings([learns]);
    await runChat(settings, withUser(MESSAGE));
    assert.equal(background.pending, 0);
    assert.equal(models[0]!.calls, 0);
  });

  const unfinished: [string, () => Promise<RunResult>, Partial<AppSettings>][] = [
    [
      "the iteration limit",
      async () => ({ stopReason: "iteration_limit", answer: null, trace: [], metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null } }),
      {},
    ],
    [
      "a run that throws",
      async () => {
        throw new Error("boom");
      },
      {},
    ],
    ["a run that times out", () => new Promise<RunResult>(() => {}), { timeoutMs: 20 }],
  ];
  for (const [label, run, extra] of unfinished) {
    it(`runs no step for ${label}`, async () => {
      const { settings, background, models } = learningSettings([learns], { run, extra });
      await runChat(settings, withUser(MESSAGE, USER));
      assert.equal(background.pending, 0);
      assert.equal(models[0]!.calls, 0);
    });
  }

  it("logs a failing step and leaves the outcome and history unchanged (FR-008)", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const failing = learningSettings([new Error("provider down")]);
    const quiet = learningSettings([NO_LEARNING]);

    const outcome = await runChat(failing.settings, withUser(MESSAGE, USER));
    const expected = await runChat(quiet.settings, withUser(MESSAGE, USER));
    await Promise.all([failing.background.settled(), quiet.background.settled()]);

    assert.deepEqual(comparable(outcome), comparable(expected));
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [
      `Learning failed for ${USER}: Error: provider down`,
    ]);
    assert.deepEqual(await facts(failing.memories), []);
    assert.equal(failing.conversations.lastMessages(outcome.conversation.id, 12).length, 2);
  });

  it("warns about a secret without ever logging it", async (t) => {
    const streams = (["log", "warn", "error"] as const).map((name) => t.mock.method(console, name, () => {}));
    const { settings, background, memories } = learningSettings([
      learningTurn({ hasLearning: true, fact: "The engineer's staging DB password is hunter2" }),
    ]);

    await runChat(settings, withUser(MESSAGE, USER));
    await background.settled();

    const [, warn] = streams;
    assert.deepEqual(warn!.mock.calls.map((call) => call.arguments[0]), [`Learning skipped for ${USER}: secret`]);
    for (const stream of streams) {
      for (const call of stream.mock.calls) assert.doesNotMatch(call.arguments.map(String).join(" "), /hunter2/);
    }
    assert.deepEqual(await facts(memories), []);
  });

  it("logs a step that times out and stores nothing", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const { settings, background, memories } = learningSettings([hangingTurn()], { extra: { learningTimeoutMs: 1 } });

    await runChat(settings, withUser(MESSAGE, USER));
    await background.settled();

    assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [`Learning timed out after 1 ms for ${USER}`]);
    assert.deepEqual(await facts(memories), []);
  });
});

describe("runChat: context breakdown", () => {
  const MESSAGE = "Which alerts are firing right now on the checkout service?";

  it("measures the real react strategy's sources when there is no history or memory (US2-AS1)", async () => {
    const tools = [...createTools(createStore())];
    const model = new ScriptedChatModel([textTurn("Two alerts.")]);
    const settings = serviceSettings(createReactStrategy({ model, tools }), new FakeConversationStore(), {
      createDependencies: () => ({ model, tools }),
    });

    const { context } = await runChat(settings, request(MESSAGE));

    const system = createReactStrategy({ model, tools }).systemPrompt ?? "";
    assert.ok(system.length > 0);
    assert.equal(context.system, estimateTokens(system));
    assert.ok(context.system > 0);
    // "[]" alone estimates to 1, so more than 1 shows the real definitions were counted.
    assert.equal(context.tools, estimateTokens(toolDefinitionsText(tools)));
    assert.ok(context.tools > 1);
    assert.equal(context.message, estimateTokens(MESSAGE));
    assert.equal(context.history, 0);
    assert.equal(context.memories, 0);
    assert.equal(context.total, context.system + context.tools + context.message);
  });

  it("measures the system prompt the strategy declares, and 0 when it declares none", async () => {
    const withPrompt = { ...recordingStrategy(async () => completed("ok")), systemPrompt: "x".repeat(400) };
    const without = recordingStrategy(async () => completed("ok"));

    const first = await runChat(serviceSettings(withPrompt, new FakeConversationStore()), request("hi"));
    const second = await runChat(serviceSettings(without, new FakeConversationStore()), request("hi"));

    assert.equal(first.context.system, 100);
    assert.equal(second.context.system, 0);
  });

  it("measures the history block of the earlier messages (US2-AS2)", async () => {
    const store = new FakeConversationStore();
    const earlier: NewMessage[] = [
      { role: "user", content: "which alerts are firing on checkout?" },
      { role: "assistant", content: "ALT-001 is firing." },
      { role: "user", content: "who owns checkout?" },
      { role: "assistant", content: "The payments team." },
      { role: "user", content: "page them" },
      { role: "assistant", content: "Paged." },
    ];
    const id = seed(store, earlier);
    const strategy = recordingStrategy(async () => completed("ok"));

    const outcome = await runChat(serviceSettings(strategy, store), request("thanks", id));

    assert.equal(outcome.conversation.historyMessages, 6);
    assert.equal(outcome.context.history, estimateTokens(historyBlock(earlier)));
    assert.ok(outcome.context.history > 0);
  });

  it("measures the memory block and counts the memory tools (US2-AS3)", async () => {
    const QUERY = "who should I page about failed purchases?";
    const facts = ["The payments team owns the checkout service", "I prefer short bullet lists", "Checkout runs on api-7"];
    const embedder = new FakeEmbedder({
      [QUERY]: unitVector({ 0: 1 }),
      // Different "other" axes keep the facts from looking like duplicates of each other.
      [facts[0] ?? ""]: scoredAgainst(0, 0.9, 5),
      [facts[1] ?? ""]: scoredAgainst(0, 0.8, 6),
      [facts[2] ?? ""]: scoredAgainst(0, 0.7, 7),
    });
    const memories = new FakeMemoryStore({ embedder });
    for (const fact of facts) await memories.remember("oncall-a", fact);
    const strategy = recordingStrategy(async () => completed("ok"));

    const withUser = await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories }), {
      ...request(QUERY),
      userId: "oncall-a",
    });
    const anonymous = await runChat(serviceSettings(strategy, new FakeConversationStore(), { memories }), request(QUERY));

    assert.equal(withUser.recalledMemories, 3);
    const recalled = await memories.recall("oncall-a", QUERY);
    assert.equal(withUser.context.memories, estimateTokens(memoryBlock(recalled)));
    assert.ok(withUser.context.memories > 0);
    assert.equal(anonymous.context.memories, 0);
    // The fake dependencies have no tools, so any tool tokens come from the memory tools.
    assert.ok(withUser.context.tools > anonymous.context.tools);
  });

  it("measures exactly the input the strategy receives: memories, then history, then the message", async () => {
    const QUERY = "who should I page about failed purchases?";
    const FACT = "The payments team owns the checkout service";
    const embedder = new FakeEmbedder({ [QUERY]: unitVector({ 0: 1 }), [FACT]: scoredAgainst(0, 0.6) });
    const memories = new FakeMemoryStore({ embedder });
    await memories.remember("oncall-a", FACT);
    const store = new FakeConversationStore();
    const earlier: NewMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const id = seed(store, earlier);
    const strategy = recordingStrategy(async () => completed("ok"));

    await runChat(serviceSettings(strategy, store, { memories }), { ...request(QUERY, id), userId: "oncall-a" });

    const recalled = await memories.recall("oncall-a", QUERY);
    assert.equal(strategy.inputs[0], memoryBlock(recalled) + historyBlock(earlier) + QUERY);
  });

  it("is set on thrown and timeout outcomes too, and adds no model call", async () => {
    const thrown = recordingStrategy(async () => {
      throw new Error("boom");
    });
    const hung = recordingStrategy(() => new Promise<RunResult>(() => {}));
    const model = new ScriptedChatModel([textTurn("x")]);

    const first = await runChat(serviceSettings(thrown, new FakeConversationStore()), request("hi"));
    const second = await runChat(
      serviceSettings(hung, new FakeConversationStore(), { timeoutMs: 20, createDependencies: () => ({ model, tools: [] }) }),
      request("hi"),
    );

    assert.equal(first.kind, "thrown");
    assert.equal(first.context.message, 1);
    assert.equal(second.kind, "timeout");
    assert.equal(second.context.message, 1);
    assert.equal(model.calls, 0);
  });
});
