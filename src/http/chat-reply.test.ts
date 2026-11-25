import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../domain/types.ts";
import { UnknownStrategyError } from "../domain/errors.ts";
import { ConversationNotFoundError } from "../domain/errors.ts";
import {
  conversationNotFoundReply,
  failureOf,
  learningLogLine,
  messagesToSave,
  shouldLearn,
  summaryLogLine,
  toHttpReply,
  unknownStrategyReply,
  withSummarization,
  type ChatOutcome,
  type RunOutcome,
  type SummarizationStep,
} from "./chat-reply.ts";
import { ChatReply, ErrorReply } from "./schemas.ts";
import type { LearningOutcome } from "../agents/learning-reflector.ts";

const metrics = { llmCalls: 2, latencyMs: 10, promptTokens: null };
const trace: RunResult["trace"] = [{ type: "answer", content: "done" }];
const conversation = { id: "conv-1", historyMessages: 4 };
const context = { system: 100, tools: 200, history: 250, memories: 30, message: 10, total: 590 };
const withHistory = { ...metrics, historyMessages: 4, recalledMemories: 2, contextBreakdown: context };

/** Attaches the conversation and the recall count every outcome carries once the service has resolved them. */
const chat = (run: RunOutcome): ChatOutcome => ({ ...run, conversation, recalledMemories: 2, context });

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

describe("toHttpReply: contextBreakdown", () => {
  it("carries the outcome's breakdown on a 200", () => {
    const result: RunResult = { stopReason: "completed", answer: "done", trace, metrics };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.deepEqual((reply.body as { metrics: { contextBreakdown: unknown } }).metrics.contextBreakdown, context);
  });

  it("carries it on a run_failed 502 that has partial metrics", () => {
    const result: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider returned 503" },
      trace,
      metrics,
    };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 502);
    assert.deepEqual((reply.body as { metrics: { contextBreakdown: unknown } }).metrics.contextBreakdown, context);
  });
});

describe("toHttpReply: promptTokens", () => {
  it("carries the run's real prompt tokens on a 200", () => {
    const result: RunResult = {
      stopReason: "completed",
      answer: "done",
      trace,
      metrics: { ...metrics, promptTokens: 360 },
    };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 200);
    assert.equal((reply.body as { metrics: { promptTokens: number | null } }).metrics.promptTokens, 360);
    ChatReply.parse(reply.body);
  });

  it("carries the tokens of the calls made before a run_failed 502", () => {
    const result: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider returned 503" },
      trace,
      metrics: { ...metrics, promptTokens: 250 },
    };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal(reply.status, 502);
    assert.equal((reply.body as { metrics: { promptTokens: number | null } }).metrics.promptTokens, 250);
    ErrorReply.parse(reply.body);
  });

  it("keeps a null count as null", () => {
    const result: RunResult = { stopReason: "completed", answer: "done", trace, metrics };
    const reply = toHttpReply(chat({ kind: "result", result }));
    assert.equal((reply.body as { metrics: { promptTokens: number | null } }).metrics.promptTokens, null);
  });

  it("gives a thrown run and a timeout no metrics at all", () => {
    for (const run of [
      { kind: "thrown", error: new Error("x") },
      { kind: "timeout", timeoutMs: 1000 },
    ] as const) {
      assert.equal("metrics" in toHttpReply(chat(run)).body, false);
    }
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

describe("shouldLearn", () => {
  const result = (stopReason: "completed" | "iteration_limit"): RunOutcome => ({
    kind: "result",
    result:
      stopReason === "completed"
        ? { stopReason, answer: "done", trace, metrics }
        : { stopReason, answer: null, trace, metrics },
  });

  it("is true only for a userId and a completed result", () => {
    assert.equal(shouldLearn("u1", result("completed")), true);
  });

  for (const [label, userId, outcome] of [
    ["no userId", undefined, result("completed")],
    ["the iteration limit", "u1", result("iteration_limit")],
    ["a thrown run", "u1", { kind: "thrown", error: new Error("boom") }],
    ["a timed-out run", "u1", { kind: "timeout", timeoutMs: 10 }],
  ] as const) {
    it(`is false for ${label}`, () => {
      assert.equal(shouldLearn(userId, outcome), false);
    });
  }
});

describe("learningLogLine", () => {
  const FACT = "The engineer's DB password is hunter2";
  const memory = { id: 7, userId: "u1", fact: FACT, createdAt: "2026-11-24T00:00:00.000Z" };
  const done = (value: LearningOutcome) => ({ kind: "done" as const, value });

  const cases = [
    ["saved", done({ kind: "saved", memory }), { stream: "log", line: "Learned [memory 7] for u1" }],
    ["duplicate", done({ kind: "duplicate", memory }), { stream: "log", line: "Learning already known as [memory 7] for u1" }],
    ["skipped: secret", done({ kind: "skipped", reason: "secret" }), { stream: "warn", line: "Learning skipped for u1: secret" }],
    [
      "skipped: invalid_fact",
      done({ kind: "skipped", reason: "invalid_fact" }),
      { stream: "warn", line: "Learning skipped for u1: invalid_fact" },
    ],
    ["skipped: no_learning", done({ kind: "skipped", reason: "no_learning" }), undefined],
    [
      "thrown",
      { kind: "thrown", error: new Error("provider down") },
      { stream: "error", line: "Learning failed for u1: Error: provider down" },
    ],
    ["thrown, not an Error", { kind: "thrown", error: "boom" }, { stream: "error", line: "Learning failed for u1: boom" }],
    ["timeout", { kind: "timeout" }, { stream: "error", line: "Learning timed out after 30000 ms for u1" }],
  ] as const;

  for (const [label, timed, expected] of cases) {
    it(`maps ${label}`, () => {
      assert.deepEqual(learningLogLine("u1", timed, 30_000), expected);
    });
  }

  it("prints the timeout it was given", () => {
    assert.deepEqual(learningLogLine("u1", { kind: "timeout" }, 1), {
      stream: "error",
      line: "Learning timed out after 1 ms for u1",
    });
  });

  it("never prints the fact text", () => {
    for (const [, timed] of cases) {
      assert.doesNotMatch(learningLogLine("u1", timed, 30_000)?.line ?? "", /hunter2|password/);
    }
  });
});

describe("withSummarization", () => {
  const stored: SummarizationStep = {
    kind: "stored",
    summary: "- Page payments",
    rendered: "RENDERED",
    absorbed: 8,
    droppedSecrets: 0,
    llmCalls: 1,
    promptTokens: 300,
  };
  const failed: SummarizationStep = { kind: "failed", reason: "thrown", error: new Error("x"), llmCalls: 2, promptTokens: null };
  const completedRun: RunOutcome = {
    kind: "result",
    result: { stopReason: "completed", answer: "done", trace, metrics: { llmCalls: 3, latencyMs: 10, promptTokens: 1000 } },
  };
  const failedRun: RunOutcome = {
    kind: "result",
    result: {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "x" },
      trace,
      metrics: { llmCalls: 2, latencyMs: 10, promptTokens: null },
    },
  };

  const metricsOf = (outcome: RunOutcome) => (outcome.kind === "result" ? outcome.result.metrics : undefined);
  const traceOf = (outcome: RunOutcome) => (outcome.kind === "result" ? outcome.result.trace : undefined);

  it("adds a stored step's calls and tokens to the metrics of a completed run", () => {
    assert.deepEqual(metricsOf(withSummarization(completedRun, stored)), { llmCalls: 4, latencyMs: 10, promptTokens: 1300 });
  });

  it("adds a failed step's calls too, and its tokens only when it reported some", () => {
    assert.deepEqual(metricsOf(withSummarization(completedRun, failed)), { llmCalls: 5, latencyMs: 10, promptTokens: 1000 });
    assert.deepEqual(metricsOf(withSummarization(completedRun, { ...failed, promptTokens: 40 })), {
      llmCalls: 5,
      latencyMs: 10,
      promptTokens: 1040,
    });
  });

  it("counts the step in a run that failed with partial metrics", () => {
    assert.deepEqual(metricsOf(withSummarization(failedRun, stored)), { llmCalls: 3, latencyMs: 10, promptTokens: 300 });
  });

  it("changes nothing for a step that was not due", () => {
    assert.equal(withSummarization(completedRun, { kind: "not_due" }), completedRun);
  });

  it("leaves a thrown run and a timed-out run unchanged", () => {
    const thrown: RunOutcome = { kind: "thrown", error: new Error("boom") };
    const timeout: RunOutcome = { kind: "timeout", timeoutMs: 5 };
    assert.equal(withSummarization(thrown, stored), thrown);
    assert.equal(withSummarization(timeout, stored), timeout);
  });

  it("puts the summarize event first in the trace of a completed run, and of a run_failed one (FR-009)", () => {
    const event = { type: "summarize", content: "RENDERED", absorbed: 8 };
    assert.deepEqual(traceOf(withSummarization(completedRun, stored)), [event, ...trace]);
    assert.deepEqual(traceOf(withSummarization(failedRun, stored)), [event, ...trace]);
    const reply = toHttpReply(chat(withSummarization(failedRun, stored)));
    assert.equal(reply.status, 502);
    assert.ok(ErrorReply.safeParse(reply.body).success);
    assert.deepEqual((reply.body as { trace: unknown[] }).trace[0], event);
  });

  it("adds no event for a failed or not-due step", () => {
    assert.deepEqual(traceOf(withSummarization(completedRun, failed)), trace);
    assert.deepEqual(traceOf(withSummarization(completedRun, { kind: "not_due" })), trace);
  });

  it("does not change the answer or the stop reason", () => {
    const outcome = withSummarization(completedRun, stored);
    assert.ok(outcome.kind === "result" && outcome.result.stopReason === "completed" && outcome.result.answer === "done");
  });
});

describe("summaryLogLine", () => {
  const ITEM = "- The staging DB password is hunter2";
  const storedStep = (droppedSecrets: number): SummarizationStep => ({
    kind: "stored",
    summary: ITEM,
    rendered: ITEM,
    absorbed: 8,
    droppedSecrets,
    llmCalls: 1,
    promptTokens: null,
  });

  const cases: [string, SummarizationStep, unknown][] = [
    ["stored", storedStep(0), { stream: "log", line: "Summarized 8 messages for conversation c1" }],
    [
      "stored with secrets dropped",
      storedStep(2),
      { stream: "log", line: "Summarized 8 messages for conversation c1, 2 lines dropped as secrets" },
    ],
    [
      "timeout",
      { kind: "failed", reason: "timeout", llmCalls: 1, promptTokens: null },
      { stream: "error", line: "Summary timed out after 30000 ms for conversation c1" },
    ],
    [
      "thrown",
      { kind: "failed", reason: "thrown", error: new Error("boom"), llmCalls: 2, promptTokens: null },
      { stream: "error", line: "Summary failed for conversation c1: Error: boom" },
    ],
    [
      "thrown, not an Error",
      { kind: "failed", reason: "thrown", error: "boom", llmCalls: 2, promptTokens: null },
      { stream: "error", line: "Summary failed for conversation c1: boom" },
    ],
    [
      "empty",
      { kind: "failed", reason: "empty", llmCalls: 1, promptTokens: null },
      { stream: "warn", line: "Summary skipped for conversation c1: empty" },
    ],
    [
      "conflict",
      { kind: "failed", reason: "conflict", llmCalls: 1, promptTokens: null },
      { stream: "warn", line: "Summary skipped for conversation c1: conflict" },
    ],
    ["not due", { kind: "not_due" }, undefined],
  ];

  for (const [label, step, expected] of cases) {
    it(`maps ${label}`, () => {
      assert.deepEqual(summaryLogLine("c1", step, 30_000), expected);
    });
  }

  it("never prints an item's text", () => {
    for (const [, step] of cases) {
      assert.doesNotMatch(summaryLogLine("c1", step, 30_000)?.line ?? "", /hunter2|password/);
    }
  });
});
