import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationSummary, SummaryText } from "./schemas.ts";

describe("SummaryText", () => {
  it("trims the text and keeps its lines", () => {
    assert.equal(SummaryText.parse("  - a\n- b \n"), "- a\n- b");
  });

  it("rejects an empty or blank summary", () => {
    assert.ok(!SummaryText.safeParse("").success);
    assert.ok(!SummaryText.safeParse("   \n ").success);
  });
});

describe("ConversationSummary", () => {
  const valid = { conversationId: "c1", summary: "- a", coveredMessages: 8, updatedAt: "2026-11-25T12:00:00.000Z" };

  it("accepts a well-formed summary", () => {
    assert.deepEqual(ConversationSummary.parse(valid), valid);
  });

  it("rejects an empty conversation id", () => {
    assert.ok(!ConversationSummary.safeParse({ ...valid, conversationId: "" }).success);
  });

  it("rejects a blank summary", () => {
    assert.ok(!ConversationSummary.safeParse({ ...valid, summary: "  " }).success);
  });

  it("requires coveredMessages to be a positive integer", () => {
    for (const coveredMessages of [0, -1, 1.5]) {
      assert.ok(!ConversationSummary.safeParse({ ...valid, coveredMessages }).success, String(coveredMessages));
    }
  });

  it("requires updatedAt to be a string", () => {
    assert.ok(!ConversationSummary.safeParse({ ...valid, updatedAt: 5 }).success);
  });
});
