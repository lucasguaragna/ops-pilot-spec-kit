import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatRequest, toIssues } from "./schemas.ts";

describe("ChatRequest", () => {
  it("accepts a minimal body and defaults the strategy to react", () => {
    assert.deepEqual(ChatRequest.parse({ message: "hi", reflect: false }), {
      message: "hi",
      strategy: "react",
      reflect: false,
    });
  });

  it("rejects a missing or non-boolean reflect", () => {
    assert.equal(ChatRequest.safeParse({ message: "hi" }).success, false);
    assert.equal(ChatRequest.safeParse({ message: "hi", reflect: "true" }).success, false);
  });

  it("rejects an empty or blank message", () => {
    assert.equal(ChatRequest.safeParse({ message: "", reflect: false }).success, false);
    assert.equal(ChatRequest.safeParse({ message: "   ", reflect: false }).success, false);
  });

  it("strips extra fields", () => {
    const parsed = ChatRequest.parse({ message: "hi", reflect: true, admin: true });
    assert.deepEqual(Object.keys(parsed).sort(), ["message", "reflect", "strategy"]);
  });

  it("keeps the strategy name as is, because the registry checks it later", () => {
    assert.equal(ChatRequest.parse({ message: "hi", reflect: false, strategy: "React" }).strategy, "React");
  });
});

describe("toIssues", () => {
  it("maps a ZodError to path and message pairs", () => {
    const parsed = ChatRequest.safeParse({ message: 42 });
    assert.ok(!parsed.success);
    const issues = toIssues(parsed.error);
    assert.deepEqual(issues.map((issue) => issue.path), [["message"], ["reflect"]]);
    for (const issue of issues) assert.equal(typeof issue.message, "string");
  });
});
