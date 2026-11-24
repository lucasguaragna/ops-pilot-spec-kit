import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../domain/types.ts";
import { UnknownStrategyError } from "../domain/errors.ts";
import { ConversationNotFoundError } from "../domain/errors.ts";
import {
  conversationNotFoundReply,
  failureOf,
  messagesToSave,
  toHttpReply,
  unknownStrategyReply,
  type ChatOutcome,
  type RunOutcome,
} from "./chat-reply.ts";
import { ChatReply, ErrorReply } from "./schemas.ts";

const metrics = { llmCalls: 2, latencyMs: 10 };
const trace: RunResult["trace"] = [{ type: "answer", content: "done" }];
const conversation = { id: "conv-1", historyMessages: 4 };
const withHistory = { ...metrics, historyMessages: 4, recalledMemories: 2 };

/** Attaches the conversation and the recall count every outcome carries once the service has resolved them. */
const chat = (run: RunOutcome): ChatOutcome => ({ ...run, conversation, recalledMemories: 2 });

describe("toHttpReply", () => {
  it("maps a completed result to 200 with the answer, trace, and metrics", () => {
    const result: RunResult = { stopReason: "completed", answer: "done", trace, metrics };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, {
      conversationId: "conv-1",
      answer: "done",
      stopReason: "completed",
      trace,
      metrics: withHistory,
    });
    ChatReply.parse(reply.body);
  });

  it("maps the iteration limit to 200 with a null answer", () => {
    const result: RunResult = { stopReason: "iteration_limit", answer: null, trace, metrics };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, {
      conversationId: "conv-1",
      answer: null,
      stopReason: "iteration_limit",
      trace,
      metrics: withHistory,
    });
    ChatReply.parse(reply.body);
  });
});

describe("toHttpReply: failures", () => {
  it("maps an error result to 502 with the run error, trace, and metrics", () => {
    const result: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider returned 503" },
      trace,
      metrics,
    };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 502);
    assert.deepEqual(reply.body, {
      error: "run_failed",
      message: "The run stopped with an error",
      runError: { name: "Error", message: "The run failed; details are in the server log" },
      conversationId: "conv-1",
      trace,
      metrics: withHistory,
    });
    ErrorReply.parse(reply.body);
  });

  it("maps a throw to 502 with the run error and no trace or metrics", () => {
    const reply = toHttpReply(chat({ kind: "thrown", error: new TypeError("bad") }));
    assert.equal(reply.status, 502);
    assert.deepEqual(reply.body, {
      error: "run_failed",
      message: "The run stopped with an error",
      runError: { name: "TypeError", message: "The run failed; details are in the server log" },
      conversationId: "conv-1",
    });
  });

  it("exposes the failure behind a 502 only through failureOf", () => {
    assert.deepEqual(failureOf({ kind: "thrown", error: new TypeError("secret detail") }), {
      name: "TypeError",
      message: "secret detail",
    });
    assert.equal(failureOf({ kind: "timeout", timeoutMs: 1 }), undefined);
  });

  it("maps a timeout to 504 with the limit", () => {
    const reply = toHttpReply(chat({ kind: "timeout", timeoutMs: 180000 }));
    assert.equal(reply.status, 504);
    assert.deepEqual(reply.body, {
      error: "timeout",
      message: "The run did not finish within 180000 ms",
      timeoutMs: 180000,
      conversationId: "conv-1",
    });
  });

  it("maps an unknown strategy to 422 with the known names", () => {
    const reply = unknownStrategyReply(new UnknownStrategyError("chain-of-thought", ["react", "plan-execute"]));
    assert.equal(reply.status, 422);
    assert.deepEqual(reply.body, {
      error: "unknown_strategy",
      message: 'Unknown strategy "chain-of-thought". Known: react, plan-execute',
      strategy: "chain-of-thought",
      knownStrategies: ["react", "plan-execute"],
    });
  });

  it("never puts a stack in a body", () => {
    const bodies = [
      toHttpReply(chat({ kind: "thrown", error: new Error("x") })).body,
      toHttpReply(chat({ kind: "timeout", timeoutMs: 1 })).body,
      unknownStrategyReply(new UnknownStrategyError("a", [])).body,
    ];
    for (const body of bodies) assert.ok(!JSON.stringify(body).includes("stack"));
  });
});

describe("conversationNotFoundReply", () => {
  it("maps the error to 404 naming the conversation", () => {
    const reply = conversationNotFoundReply(new ConversationNotFoundError("abc"));
    assert.equal(reply.status, 404);
    assert.deepEqual(reply.body, {
      error: "conversation_not_found",
      message: "Conversation not found: abc",
      conversationId: "abc",
    });
    ErrorReply.parse(reply.body);
  });
});

describe("messagesToSave", () => {
  const stop = (stopReason: "completed" | "iteration_limit" | "error"): RunResult =>
    stopReason === "completed"
      ? { stopReason, answer: "the answer", trace, metrics }
      : stopReason === "iteration_limit"
        ? { stopReason, answer: null, trace, metrics }
        : { stopReason, answer: null, error: { name: "Error", message: "x" }, trace, metrics };

  const cases: [string, RunOutcome, { role: string; content: string }[]][] = [
    [
      "a completed run",
      { kind: "result", result: stop("completed") },
      [
        { role: "user", content: "the question" },
        { role: "assistant", content: "the answer" },
      ],
    ],
    ["the iteration limit", { kind: "result", result: stop("iteration_limit") }, []],
    ["an error result", { kind: "result", result: stop("error") }, []],
    ["a throw", { kind: "thrown", error: new Error("boom") }, []],
    ["a timeout", { kind: "timeout", timeoutMs: 1 }, []],
  ];
  for (const [label, outcome, expected] of cases) {
    it(`gives ${expected.length} messages for ${label}`, () => {
      assert.deepEqual(messagesToSave("the question", outcome), expected);
    });
  }
});
