import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { addPromptTokens, estimateTokens, promptTokensOf } from "./tokens.ts";

/** An LLMResult whose generations carry one chat message each, with the given usage metadata. */
function resultWith(...usages: (Record<string, number> | undefined)[]): LLMResult {
  return {
    generations: [
      usages.map((usage) => ({
        text: "ok",
        message: new AIMessage({
          content: "ok",
          ...(usage === undefined ? {} : { usage_metadata: usage as never }),
        }),
      })),
    ],
  };
}

const usage = (input: number) => ({ input_tokens: input, output_tokens: 5, total_tokens: input + 5 });

describe("estimateTokens", () => {
  it("rounds characters / 4 up", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("x".repeat(400)), 100);
  });

  it("counts UTF-16 code units, so an emoji is 2 characters", () => {
    assert.equal(estimateTokens("ação"), 1);
    assert.equal(estimateTokens("😀"), 1);
    assert.equal(estimateTokens("😀😀"), 1);
    assert.equal(estimateTokens("😀😀😀"), 2);
  });

  it("stays linear and never throws on a very long text", () => {
    assert.equal(estimateTokens("y".repeat(100_000)), 25_000);
  });
});

describe("promptTokensOf", () => {
  it("reads the input tokens a generation reported", () => {
    assert.equal(promptTokensOf(resultWith(usage(120))), 120);
  });

  it("sums the generations that reported", () => {
    assert.equal(promptTokensOf(resultWith(usage(100), usage(50))), 150);
  });

  it("is undefined when no generation reported usage", () => {
    assert.equal(promptTokensOf(resultWith(undefined)), undefined);
    assert.equal(promptTokensOf({ generations: [] }), undefined);
    assert.equal(promptTokensOf({ generations: [[{ text: "plain" }]] }), undefined);
  });

  it("skips a generation without usage and sums the rest", () => {
    assert.equal(promptTokensOf(resultWith(undefined, usage(70))), 70);
  });

  it("counts only a non-negative integer", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(promptTokensOf(resultWith({ input_tokens: bad, output_tokens: 0, total_tokens: 0 })), undefined);
    }
    assert.equal(promptTokensOf(resultWith(usage(0))), 0);
  });
});

describe("addPromptTokens", () => {
  it("stays null while nothing was reported", () => {
    assert.equal(addPromptTokens(null, undefined), null);
    assert.equal(addPromptTokens(null, null), null);
  });

  it("starts from the first reported value, even 0", () => {
    assert.equal(addPromptTokens(null, 0), 0);
    assert.equal(addPromptTokens(null, 40), 40);
  });

  it("keeps the total when a call reports nothing", () => {
    assert.equal(addPromptTokens(100, null), 100);
    assert.equal(addPromptTokens(100, undefined), 100);
  });

  it("adds a reported value to the total", () => {
    assert.equal(addPromptTokens(100, 50), 150);
  });
});
