import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../domain/types.ts";
import { formatEvent, formatMetrics, formatResult } from "./format.ts";

describe("formatEvent", () => {
  it("formats each event type", () => {
    assert.equal(formatEvent({ type: "thought", content: "Check alerts" }), "[thought] Check alerts");
    assert.equal(
      formatEvent({ type: "action", tool: "list_alerts", args: { status: "firing" } }),
      '[action] list_alerts {"status":"firing"}',
    );
    assert.equal(
      formatEvent({ type: "observation", tool: "list_alerts", content: "[]" }),
      "[observation] list_alerts: []",
    );
    assert.equal(
      formatEvent({ type: "plan", steps: ["List alerts", "Open incident"] }),
      "[plan]\n  1. List alerts\n  2. Open incident",
    );
    assert.equal(
      formatEvent({ type: "critique", approved: true, content: "Backed by the trace" }),
      "[critique] approved: Backed by the trace",
    );
    assert.equal(
      formatEvent({ type: "critique", approved: false, fix: "rerun", content: "No incident opened" }),
      "[critique] rejected (rerun): No incident opened",
    );
    assert.equal(
      formatEvent({ type: "critique", approved: false, fix: "rewrite", content: "Wrong id" }),
      "[critique] rejected (rewrite): Wrong id",
    );
    assert.equal(formatEvent({ type: "critique", approved: true, content: "" }), "[critique] approved");
    assert.equal(formatEvent({ type: "answer", content: "Done" }), "[answer] Done");
  });
});

describe("formatEvent: summarize", () => {
  it("names the number of messages absorbed, then the rendered summary without its trailing blank lines", () => {
    assert.equal(
      formatEvent({ type: "summarize", absorbed: 8, content: "Summary of the earlier conversation:\nDecisions:\n- A\n\n" }),
      "[summarize] (8 messages): Summary of the earlier conversation:\nDecisions:\n- A",
    );
  });
});

describe("formatMetrics", () => {
  it("prints LLM calls and latency", () => {
    assert.equal(formatMetrics({ llmCalls: 3, latencyMs: 120, promptTokens: null }), "llmCalls: 3 | latencyMs: 120");
  });
});

describe("formatResult", () => {
  const metrics = { llmCalls: 2, latencyMs: 50, promptTokens: null };

  it("prints name, trace, answer, stop reason, and metrics in order", () => {
    const result: RunResult = {
      stopReason: "completed",
      answer: "Done",
      trace: [{ type: "answer", content: "Done" }],
      metrics,
    };
    assert.equal(
      formatResult("react", result),
      [
        "=== react ===",
        "[answer] Done",
        "Answer: Done",
        "Stop reason: completed",
        "llmCalls: 2 | latencyMs: 50",
      ].join("\n"),
    );
  });

  it("prints the error for a failed run", () => {
    const result: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider down" },
      trace: [],
      metrics,
    };
    const text = formatResult("react", result);
    assert.match(text, /Answer: \(none\)/);
    assert.match(text, /Stop reason: error \(Error: Provider down\)/);
  });
});
