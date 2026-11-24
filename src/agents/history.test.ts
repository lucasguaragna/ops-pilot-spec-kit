import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy, RunOptions, RunResult } from "../domain/types.ts";
import { composeInput, HISTORY_LIMIT, historyBlock, withHistory } from "./history.ts";

const history: NewMessage[] = [
  { role: "user", content: "which alerts are firing on checkout?" },
  { role: "assistant", content: "ALT-001 is firing." },
];

describe("composeInput", () => {
  it("returns the message unchanged when there is no history", () => {
    assert.equal(composeInput([], "hi"), "hi");
  });

  it("puts the labelled history, oldest first, ahead of the current request", () => {
    assert.equal(
      composeInput(history, "open an incident for the worst one"),
      [
        "Conversation so far (oldest first):",
        "User: which alerts are firing on checkout?",
        "Assistant: ALT-001 is firing.",
        "",
        "Current request: open an incident for the worst one",
      ].join("\n"),
    );
  });

  it("keeps the order of the history it is given", () => {
    const input = composeInput([history[1] as NewMessage, history[0] as NewMessage], "next");
    assert.ok(input.indexOf("Assistant: ALT-001") < input.indexOf("User: which alerts"));
  });
});

describe("historyBlock", () => {
  it("is empty for no history", () => {
    assert.equal(historyBlock([]), "");
  });

  it("is everything composeInput puts ahead of the message", () => {
    assert.equal(
      historyBlock(history),
      "Conversation so far (oldest first):\nUser: which alerts are firing on checkout?\nAssistant: ALT-001 is firing.\n\nCurrent request: ",
    );
  });

  it("composeInput is the block followed by the message, for any history", () => {
    for (const earlier of [[], history, history.slice(0, 1)]) {
      assert.equal(composeInput(earlier, "and now?"), historyBlock(earlier) + "and now?");
    }
  });
});

describe("withHistory", () => {
  const result: RunResult = {
    stopReason: "completed",
    answer: "ok",
    trace: [],
    metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null },
  };

  function recording(): ReasoningStrategy & { calls: { input: string; options: RunOptions }[] } {
    const calls: { input: string; options: RunOptions }[] = [];
    return {
      name: "react",
      calls,
      async run(input, options) {
        calls.push({ input, options });
        return result;
      },
    };
  }

  it("runs the inner strategy with the composed input and the same options and result", async () => {
    const inner = recording();
    const options: RunOptions = { maxIterations: 7, signal: new AbortController().signal };

    const got = await withHistory(inner, history).run("next", options);

    assert.equal(got, result);
    assert.equal(inner.calls.length, 1);
    assert.equal(inner.calls[0]?.input, composeInput(history, "next"));
    assert.equal(inner.calls[0]?.options, options);
  });

  it("passes the message through when the history is empty and keeps the strategy name", async () => {
    const inner = recording();
    const wrapped = withHistory(inner, []);

    await wrapped.run("hi", { maxIterations: 1 });

    assert.equal(wrapped.name, "react");
    assert.equal(inner.calls[0]?.input, "hi");
  });
});

describe("HISTORY_LIMIT", () => {
  it("is 12 messages", () => {
    assert.equal(HISTORY_LIMIT, 12);
  });
});

describe("withHistory: systemPrompt", () => {
  const base = (extra: Partial<ReasoningStrategy>): ReasoningStrategy => ({
    name: "react",
    async run() {
      throw new Error("not called");
    },
    ...extra,
  });

  it("exposes the wrapped strategy's system prompt", () => {
    assert.equal(withHistory(base({ systemPrompt: "S" }), history).systemPrompt, "S");
  });

  it("has no systemPrompt key when the wrapped strategy has none", () => {
    assert.equal("systemPrompt" in withHistory(base({}), history), false);
  });
});
