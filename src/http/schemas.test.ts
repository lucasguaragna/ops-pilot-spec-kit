import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatReply, ChatRequest, ErrorReply, toIssues } from "./schemas.ts";

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

describe("ChatRequest: conversationId", () => {
  const uuid = "3f0c1f6e-8d1e-4c43-9c8e-5f0a3b2d9a10";

  it("accepts a missing conversationId and a UUID", () => {
    assert.equal(ChatRequest.parse({ message: "hi", reflect: false }).conversationId, undefined);
    assert.equal(ChatRequest.parse({ message: "hi", reflect: false, conversationId: uuid }).conversationId, uuid);
  });

  it("rejects an id that is not a UUID, with the issue on conversationId", () => {
    for (const conversationId of ["abc", "", 42]) {
      const parsed = ChatRequest.safeParse({ message: "hi", reflect: false, conversationId });
      assert.ok(!parsed.success);
      assert.deepEqual(toIssues(parsed.error).map((issue) => issue.path), [["conversationId"]]);
    }
  });
});

describe("reply schemas: conversation fields", () => {
  const id = "3f0c1f6e-8d1e-4c43-9c8e-5f0a3b2d9a10";
  const metrics = { llmCalls: 1, latencyMs: 2, historyMessages: 0, recalledMemories: 0 };

  it("requires conversationId and historyMessages on a 200", () => {
    const reply = { answer: "ok", stopReason: "completed", trace: [], metrics, conversationId: id };
    assert.ok(ChatReply.safeParse(reply).success);
    assert.equal(ChatReply.safeParse({ ...reply, conversationId: undefined }).success, false);
    assert.equal(ChatReply.safeParse({ ...reply, metrics: { llmCalls: 1, latencyMs: 2 } }).success, false);
  });

  it("requires conversationId on run_failed and timeout", () => {
    const failed = { error: "run_failed", message: "m", runError: { name: "Error", message: "m" } };
    assert.equal(ErrorReply.safeParse(failed).success, false);
    assert.ok(ErrorReply.safeParse({ ...failed, conversationId: id }).success);
    const timeout = { error: "timeout", message: "m", timeoutMs: 5 };
    assert.equal(ErrorReply.safeParse(timeout).success, false);
    assert.ok(ErrorReply.safeParse({ ...timeout, conversationId: id }).success);
  });

  it("accepts the 404 conversation_not_found shape", () => {
    assert.ok(
      ErrorReply.safeParse({ error: "conversation_not_found", message: `Conversation not found: ${id}`, conversationId: id })
        .success,
    );
  });
});

describe("ChatRequest: userId", () => {
  const body = { message: "hi", reflect: false };

  it("is optional and trimmed", () => {
    assert.equal(ChatRequest.parse(body).userId, undefined);
    assert.equal(ChatRequest.parse({ ...body, userId: " oncall-a " }).userId, "oncall-a");
  });

  it("rejects an empty, a blank, a 129-character, and a non-string user id", () => {
    for (const userId of ["", "   ", "x".repeat(129), 42]) {
      const parsed = ChatRequest.safeParse({ ...body, userId });
      assert.equal(parsed.success, false, `accepted ${JSON.stringify(userId)}`);
      assert.deepEqual(toIssues(parsed.error!).map((issue) => issue.path), [["userId"]]);
    }
  });
});

describe("reply schemas: recalledMemories", () => {
  it("is required on a 200 and must be a non-negative integer", () => {
    const reply = {
      conversationId: "3f0c1f6e-8d1e-4c43-9c8e-5f0a3b2d9a10",
      answer: "ok",
      stopReason: "completed",
      trace: [],
      metrics: { llmCalls: 1, latencyMs: 2, historyMessages: 0, recalledMemories: 3 },
    };
    assert.ok(ChatReply.safeParse(reply).success);
    for (const recalledMemories of [undefined, -1, 1.5]) {
      assert.equal(ChatReply.safeParse({ ...reply, metrics: { ...reply.metrics, recalledMemories } }).success, false);
    }
  });
});
