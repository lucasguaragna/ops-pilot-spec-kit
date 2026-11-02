import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../domain/types.ts";
import { UnknownStrategyError } from "../domain/errors.ts";
import { toHttpReply, unknownStrategyReply } from "./chat-reply.ts";
import { ChatReply, ErrorReply } from "./schemas.ts";

const metrics = { llmCalls: 2, latencyMs: 10 };
const trace: RunResult["trace"] = [{ type: "answer", content: "done" }];

describe("toHttpReply", () => {
  it("maps a completed result to 200 with the answer, trace, and metrics", () => {
    const result: RunResult = { stopReason: "completed", answer: "done", trace, metrics };
    const reply = toHttpReply({ kind: "result", result });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { answer: "done", stopReason: "completed", trace, metrics });
    ChatReply.parse(reply.body);
  });

  it("maps the iteration limit to 200 with a null answer", () => {
    const result: RunResult = { stopReason: "iteration_limit", answer: null, trace, metrics };
    const reply = toHttpReply({ kind: "result", result });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { answer: null, stopReason: "iteration_limit", trace, metrics });
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
    const reply = toHttpReply({ kind: "result", result });
    assert.equal(reply.status, 502);
    assert.deepEqual(reply.body, {
      error: "run_failed",
      message: "The run stopped with an error",
      runError: { name: "Error", message: "Provider returned 503" },
      trace,
      metrics,
    });
    ErrorReply.parse(reply.body);
  });

  it("maps a throw to 502 with the run error and no trace or metrics", () => {
    const reply = toHttpReply({ kind: "thrown", error: new TypeError("bad") });
    assert.equal(reply.status, 502);
    assert.deepEqual(reply.body, {
      error: "run_failed",
      message: "The run stopped with an error",
      runError: { name: "TypeError", message: "bad" },
    });
  });

  it("maps a timeout to 504 with the limit", () => {
    const reply = toHttpReply({ kind: "timeout", timeoutMs: 180000 });
    assert.equal(reply.status, 504);
    assert.deepEqual(reply.body, {
      error: "timeout",
      message: "The run did not finish within 180000 ms",
      timeoutMs: 180000,
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
      toHttpReply({ kind: "thrown", error: new Error("x") }).body,
      toHttpReply({ kind: "timeout", timeoutMs: 1 }).body,
      unknownStrategyReply(new UnknownStrategyError("a", [])).body,
    ];
    for (const body of bodies) assert.ok(!JSON.stringify(body).includes("stack"));
  });
});
