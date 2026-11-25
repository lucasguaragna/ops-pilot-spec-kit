import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult, TraceEvent } from "../domain/types.ts";
import { finalizeTrace, tagNode } from "./node-trace.ts";

const metrics = { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null };
const completed = (trace: TraceEvent[]): RunResult => ({ stopReason: "completed", answer: "done", trace, metrics });

describe("tagNode", () => {
  it("adds the node to each event and leaves the input alone", () => {
    const events: TraceEvent[] = [{ type: "thought", content: "hmm" }, { type: "plan", steps: ["a"] }];
    assert.deepEqual(tagNode(events, "react"), [
      { type: "thought", content: "hmm", node: "react" },
      { type: "plan", steps: ["a"], node: "react" },
    ]);
    assert.equal("node" in events[0]!, false);
  });
});

describe("finalizeTrace", () => {
  it("moves the last answer of a completed run to the response node", () => {
    const trace = finalizeTrace("react", completed([{ type: "thought", content: "t" }, { type: "answer", content: "done" }]));
    assert.deepEqual(trace.map((event) => event.node), ["react", "response"]);
  });

  it("keeps a rejected draft with the strategy and moves only the final answer", () => {
    const trace = finalizeTrace(
      "reflect",
      completed([
        { type: "answer", content: "draft" },
        { type: "critique", approved: false, fix: "rerun", content: "wrong" },
        { type: "answer", content: "done" },
        { type: "critique", approved: true, content: "ok" },
      ]),
    );
    assert.deepEqual(trace.map((event) => event.node), ["reflect", "reflect", "response", "reflect"]);
  });

  it("gives no response event to a run that hit the iteration limit", () => {
    const result: RunResult = { stopReason: "iteration_limit", answer: null, trace: [{ type: "thought", content: "t" }], metrics };
    assert.deepEqual(finalizeTrace("plan-execute", result).map((event) => event.node), ["plan-execute"]);
  });

  it("gives no response event to a failed run", () => {
    const result: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "x" },
      trace: [{ type: "answer", content: "partial" }],
      metrics,
    };
    assert.deepEqual(finalizeTrace("react", result).map((event) => event.node), ["react"]);
  });

  it("tags a completed run that has no answer event", () => {
    assert.deepEqual(finalizeTrace("react", completed([])), []);
  });
});
