import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ConversationNotFoundError, EmbeddingError, UnknownStrategyError } from "../domain/errors.ts";
import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy, RunResult } from "../domain/types.ts";
import { FakeConversationStore } from "../testing/fake-conversation-store.ts";
import { composeMemoryInput } from "../agents/memories.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { FakeMemoryStore } from "../testing/fake-memory-store.ts";
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
  metrics: { llmCalls: 1, latencyMs: 1 },
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
    createDependencies: () => ({ model: {} as BaseChatModel, tools: [] }),
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

  it("uses only the 12 newest earlier messages, oldest first", async () => {
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
    assert.equal(outcome.conversation.historyMessages, 12);
    assert.ok(!input.includes("msg-08"));
    assert.ok(input.includes("msg-09"));
    assert.ok(input.indexOf("msg-09") < input.indexOf("msg-20"));
  });

  it("uses every message when there are fewer than the limit", async () => {
    const store = new FakeConversationStore();
    const id = seed(store, Array.from({ length: 5 }, (_, index) => ({ role: "user" as const, content: `m${index}` })));
    const outcome = await runChat(serviceSettings(recordingStrategy(async () => completed("ok")), store), request("next", id));
    assert.equal(outcome.conversation.historyMessages, 5);
  });

  it("honours an explicit historyLimit", async () => {
    const store = new FakeConversationStore();
    const id = seed(store, Array.from({ length: 6 }, (_, index) => ({ role: "user" as const, content: `m${index}` })));
    const settings = serviceSettings(recordingStrategy(async () => completed("ok")), store, { historyLimit: 3 });
    assert.equal((await runChat(settings, request("next", id))).conversation.historyMessages, 3);
  });

  it("defaults the history window to 12", () => {
    const settings = serviceSettings(recordingStrategy(async () => completed("ok")), new FakeConversationStore());
    assert.equal(settings.historyLimit, 12);
  });

  const unsaved: [string, () => Promise<RunResult>, Partial<AppSettings>][] = [
    [
      "a run that ends at the iteration limit",
      async () => ({ stopReason: "iteration_limit", answer: null, trace: [], metrics: { llmCalls: 1, latencyMs: 1 } }),
      {},
    ],
    [
      "a run that returns an error",
      async () => ({
        stopReason: "error",
        answer: null,
        error: { name: "Error", message: "x" },
        trace: [],
        metrics: { llmCalls: 1, latencyMs: 1 },
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
});
