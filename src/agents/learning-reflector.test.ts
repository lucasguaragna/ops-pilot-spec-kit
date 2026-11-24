import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { STRUCTURED_ATTEMPTS } from "./structured-output.ts";
import { createLearningReflector, factToSave, learningMessages, looksLikeSecret } from "./learning-reflector.ts";
import { FakeEmbedder, scoredAgainst, unitVector } from "../testing/fake-embedder.ts";
import { FakeMemoryStore } from "../testing/fake-memory-store.ts";
import { learningTurn, NO_LEARNING } from "../testing/learning-turns.ts";
import { hangingTurn, ScriptedChatModel, textTurn, type ScriptedTurn } from "../testing/scripted-chat-model.ts";

const USER = "oncall-a";
const FACT = "The engineer is on the payments team";
const MESSAGE = "I'm on the payments team. Which alerts are firing?";

describe("learningMessages", () => {
  it("is a system message with the rules, then only the engineer's message", () => {
    const messages = learningMessages("hi");
    assert.equal(messages.length, 2);
    const [system, human] = messages;
    assert.ok(system instanceof SystemMessage);
    assert.ok(human instanceof HumanMessage);
    assert.equal(human.content, "The engineer's message:\nhi");

    const rules = String(system.content);
    for (const phrase of [
      /still be true after this request/,
      /Requests, questions, and the current state of an alert or incident are not lasting facts/,
      /Never put a password, key, token, connection string, or any other credential/,
      /At most one fact/,
      /one short English sentence/,
      /"the engineer"/,
      /hasLearning: false and fact: ""/,
    ]) {
      assert.match(rules, phrase);
    }
  });
});

describe("factToSave", () => {
  it("skips with no_learning when hasLearning is false, even with a fact", () => {
    assert.deepEqual(factToSave({ hasLearning: false, fact: FACT }), { kind: "skip", reason: "no_learning" });
  });

  for (const [label, fact] of [
    ["empty", ""],
    ["blank", "   "],
    ["501 characters after trimming", `  ${"a ".repeat(250)}b  `],
  ] as const) {
    it(`skips with invalid_fact for a ${label} fact`, () => {
      assert.deepEqual(factToSave({ hasLearning: true, fact }), { kind: "skip", reason: "invalid_fact" });
    });
  }

  it("saves the trimmed fact", () => {
    assert.deepEqual(factToSave({ hasLearning: true, fact: "  The engineer owns checkout  " }), {
      kind: "save",
      fact: "The engineer owns checkout",
    });
  });

  it("accepts a fact of exactly 500 characters", () => {
    const fact = "x".repeat(500);
    assert.deepEqual(factToSave({ hasLearning: true, fact }), { kind: "save", fact });
  });
});

/** A reflector over a scripted model and a fake store; the embedder knows FACT and its near copy. */
function reflectorWith(turns: readonly ScriptedTurn[], vectors: Record<string, Float32Array> = {}) {
  const model = new ScriptedChatModel(turns);
  const embedder = new FakeEmbedder({ [FACT]: unitVector({ 0: 1 }), ...vectors });
  const memories = new FakeMemoryStore({ embedder });
  const prompts: BaseMessage[][] = [];
  model.callbacks = [
    {
      handleChatModelStart: (_llm: unknown, messages: BaseMessage[][]) => {
        prompts.push(...messages);
      },
    },
  ];
  return { model, embedder, memories, prompts, reflector: createLearningReflector({ model, memories }) };
}

const live = () => new AbortController().signal;

describe("createLearningReflector", () => {
  it("saves a valid fact and resolves to saved", async () => {
    const { reflector, memories } = reflectorWith([learningTurn({ hasLearning: true, fact: FACT })]);

    const outcome = await reflector.learn(USER, MESSAGE, live());

    assert.equal(outcome.kind, "saved");
    assert.equal(outcome.kind === "saved" && outcome.memory.fact, FACT);
    assert.deepEqual(
      (await memories.recall(USER, FACT)).map((memory) => memory.fact),
      [FACT],
    );
  });

  it("resolves to duplicate with the existing memory for a close rewording, storing nothing new", async () => {
    const REWORDED = "The engineer works on the payments team";
    const { reflector, memories } = reflectorWith([learningTurn({ hasLearning: true, fact: REWORDED })], {
      [REWORDED]: scoredAgainst(0, 0.95),
    });
    const { memory: existing } = await memories.remember(USER, FACT);

    const outcome = await reflector.learn(USER, MESSAGE, live());

    assert.deepEqual(outcome, { kind: "duplicate", memory: existing });
    assert.equal((await memories.recall(USER, FACT)).length, 1);
  });

  it("skips with no_learning and never embeds", async () => {
    const { reflector, embedder } = reflectorWith([NO_LEARNING]);
    assert.deepEqual(await reflector.learn(USER, "Which alerts are firing?", live()), {
      kind: "skipped",
      reason: "no_learning",
    });
    assert.deepEqual(embedder.calls, []);
  });

  it("calls the model once, with only the engineer's message and no history", async () => {
    const { reflector, model, prompts } = reflectorWith([NO_LEARNING]);
    await reflector.learn(USER, MESSAGE, live());

    assert.equal(model.calls, 1);
    assert.equal(prompts.length, 1);
    const expected = learningMessages(MESSAGE);
    assert.deepEqual(
      prompts[0]!.map((message) => [message.getType(), message.content]),
      expected.map((message) => [message.getType(), message.content]),
    );
  });

  it("rejects after the model answers in text on every attempt, and stores nothing", async () => {
    const { reflector, model, embedder } = reflectorWith([textTurn("I think they own checkout")]);
    await assert.rejects(reflector.learn(USER, MESSAGE, live()), /no structured output/);
    assert.equal(model.calls, STRUCTURED_ATTEMPTS);
    assert.deepEqual(embedder.calls, []);
  });

  it("rejects when the signal aborts while the model call hangs, and stores nothing", async () => {
    const { reflector, embedder } = reflectorWith([hangingTurn()]);
    const controller = new AbortController();
    const learning = reflector.learn(USER, MESSAGE, controller.signal);
    controller.abort();
    await assert.rejects(learning);
    assert.deepEqual(embedder.calls, []);
  });

  it("rejects without calling remember when the signal aborts after the model answered", async () => {
    const { reflector, model, memories } = reflectorWith([learningTurn({ hasLearning: true, fact: FACT })]);
    const controller = new AbortController();
    // Fires once the model has produced its answer, before the reflector reaches remember.
    model.callbacks = [{ handleLLMEnd: () => controller.abort() }];
    const remember = mock.method(memories, "remember");

    await assert.rejects(reflector.learn(USER, MESSAGE, controller.signal));
    assert.equal(remember.mock.callCount(), 0);
  });
});

describe("looksLikeSecret", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlMTIz";
  const secrets = [
    "The staging DB password is hunter2",
    "passwd: hunter2",
    "api_key=abc123",
    "The API key is abc123",
    "token: xyz789",
    "Bearer abc.def",
    "Authorization: Bearer abc123",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "postgres://admin:s3cret@db.internal:5432/app",
    "sk-" + "a1".repeat(12),
    "ghp_" + "A1".repeat(18),
    "github_pat_" + "A1".repeat(20),
    "xoxb-1234-abcd",
    "AKIA" + "ABCDEFGH12345678",
    `The session token looks like ${jwt}`,
    "a1".repeat(16),
  ];
  for (const text of secrets) {
    it(`flags ${JSON.stringify(text)}`, () => {
      assert.equal(looksLikeSecret(text), true);
    });
  }

  const harmless = [
    "The engineer owns the checkout alerts",
    "The engineer rotates API keys monthly",
    "Tokens expire after one hour on the payments API",
    "The payments API uses bearer authentication",
    "The engineer prefers risk-based alerting",
    "The checkout nodes are disk-heavy",
    "https://grafana.internal/d/checkout",
    "a".repeat(32),
    "a1".repeat(15) + "a",
  ];
  for (const text of harmless) {
    it(`lets ${JSON.stringify(text)} through`, () => {
      assert.equal(looksLikeSecret(text), false);
    });
  }
});

describe("factToSave: secrets", () => {
  it("skips with secret for a valid fact that looks like a credential", () => {
    assert.deepEqual(factToSave({ hasLearning: true, fact: "The engineer's DB password is hunter2" }), {
      kind: "skip",
      reason: "secret",
    });
  });

  it("validates before the secret check, so an over-long secret is invalid_fact", () => {
    const fact = `The DB password is hunter2 ${"x".repeat(480)}`;
    assert.ok(fact.length > 500);
    assert.deepEqual(factToSave({ hasLearning: true, fact }), { kind: "skip", reason: "invalid_fact" });
  });
});

describe("createLearningReflector: never a secret or a one-off request", () => {
  it("skips a secret the model wrongly proposes, embedding and storing nothing (SC-002)", async () => {
    const { reflector, embedder, memories } = reflectorWith([
      learningTurn({ hasLearning: true, fact: "The engineer's DB password is hunter2" }),
    ]);
    const remember = mock.method(memories, "remember");
    assert.deepEqual(await reflector.learn(USER, "the DB password is hunter2", live()), {
      kind: "skipped",
      reason: "secret",
    });
    assert.deepEqual(embedder.calls, []);
    assert.equal(remember.mock.callCount(), 0);
  });

  it("saves the lasting part of a message that also holds a secret", async () => {
    const OWNS = "The engineer owns checkout";
    const { reflector } = reflectorWith([learningTurn({ hasLearning: true, fact: OWNS })], {
      [OWNS]: unitVector({ 2: 1 }),
    });
    const outcome = await reflector.learn(USER, "I own checkout; the DB password is hunter2", live());
    assert.equal(outcome.kind, "saved");
    assert.equal(outcome.kind === "saved" && outcome.memory.fact, OWNS);
  });

  for (const message of ["Open an incident for checkout", "Resolve INC-004", "Which alerts are firing?"]) {
    it(`stores nothing for the one-off request ${JSON.stringify(message)}`, async () => {
      const { reflector, embedder } = reflectorWith([NO_LEARNING]);
      assert.deepEqual(await reflector.learn(USER, message, live()), { kind: "skipped", reason: "no_learning" });
      assert.deepEqual(embedder.calls, []);
    });
  }
});
