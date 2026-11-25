import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy, RunOptions, RunResult } from "../domain/types.ts";
import {
  composeInput,
  HISTORY_WINDOW,
  historyBlock,
  MAX_VERBATIM,
  planHistory,
  SUMMARY_BATCH,
  SUMMARY_MAX_TOKENS,
  withHistory,
} from "./history.ts";

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

describe("history constants", () => {
  it("keeps 8 messages word for word, summarizes in batches of 8, and caps the rest at 14", () => {
    assert.equal(HISTORY_WINDOW, 8);
    assert.equal(SUMMARY_BATCH, 8);
    assert.equal(MAX_VERBATIM, 14);
    assert.equal(SUMMARY_MAX_TOKENS, 300);
  });
});

describe("planHistory", () => {
  const messages = (count: number): NewMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${index + 1}`,
    }));
  const contents = (list: readonly NewMessage[]) => list.map((message) => message.content);

  it("is not due and gives everything for 0 to 14 uncovered messages", () => {
    for (const length of [0, 1, 8, 14]) {
      const plan = planHistory(messages(length));
      assert.deepEqual(plan.toSummarize, [], `length ${length}`);
      assert.deepEqual(contents(plan.verbatim), contents(messages(length)), `length ${length}`);
    }
  });

  it("is due on a batch boundary: the 8 oldest are summarized and the last 8 stay (lengths 16 and 17)", () => {
    for (const length of [16, 17]) {
      const all = messages(length);
      const plan = planHistory(all);
      assert.deepEqual(contents(plan.toSummarize), contents(all.slice(0, length - 8)), `length ${length}`);
      assert.deepEqual(contents(plan.verbatim), contents(all.slice(-8)), `length ${length}`);
    }
  });

  it("absorbs everything outside the window at the next boundary after a failure (length 24)", () => {
    const all = messages(24);
    const plan = planHistory(all);
    assert.equal(plan.toSummarize.length, 16);
    assert.deepEqual(contents(plan.toSummarize), contents(all.slice(0, 16)));
    assert.deepEqual(contents(plan.verbatim), contents(all.slice(-8)));
  });

  it("is not due between boundaries and caps the verbatim messages at 14 (lengths 15, 18, 20, 22)", () => {
    for (const length of [15, 18, 20, 22]) {
      const all = messages(length);
      const plan = planHistory(all);
      assert.deepEqual(plan.toSummarize, [], `length ${length}`);
      assert.equal(plan.verbatim.length, Math.min(length, 14), `length ${length}`);
      assert.deepEqual(contents(plan.verbatim), contents(all.slice(-14)), `length ${length}`);
    }
  });

  it("is due exactly once in every four exchanges when nothing is ever stored, whatever the parity", () => {
    for (const start of [0, 1]) {
      const due: number[] = [];
      for (let exchange = 0; exchange < 40; exchange++) {
        if (planHistory(messages(start + exchange * 2)).toSummarize.length > 0) due.push(exchange);
      }
      assert.ok(due.length >= 6, `start ${start}`);
      const gaps = due.slice(1).map((exchange, index) => exchange - (due[index] ?? 0));
      assert.deepEqual(gaps, gaps.map(() => 4), `start ${start}`);
    }
  });
});

describe("historyBlock with a summary", () => {
  it("is empty when both the history and the summary are empty", () => {
    assert.equal(historyBlock([], ""), "");
    assert.equal(historyBlock([]), "");
  });

  it("is byte-identical to the history-only block when there is no summary", () => {
    assert.equal(historyBlock(history), historyBlock(history, ""));
  });

  it("puts the summary ahead of the conversation block", () => {
    assert.equal(historyBlock(history, "S\n\n"), "S\n\n" + historyBlock(history));
  });

  it("gives the summary alone when no message is verbatim", () => {
    assert.equal(historyBlock([], "S\n\n"), "S\n\n");
  });

  it("composeInput is the block followed by the message", () => {
    assert.equal(composeInput(history, "and now?", "S\n\n"), historyBlock(history, "S\n\n") + "and now?");
    assert.equal(composeInput(history, "m"), composeInput(history, "m", ""));
  });
});

describe("withHistory with a summary", () => {
  it("runs the strategy with the summary, then the history, then the message", async () => {
    const seen: string[] = [];
    const inner: ReasoningStrategy = {
      name: "react",
      async run(input) {
        seen.push(input);
        return { stopReason: "completed", answer: "ok", trace: [], metrics: { llmCalls: 1, latencyMs: 1, promptTokens: null } };
      },
    };
    await withHistory(inner, history, "S\n\n").run("next", { maxIterations: 1 });
    assert.equal(seen[0], composeInput(history, "next", "S\n\n"));
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
