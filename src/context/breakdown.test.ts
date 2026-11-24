import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "../store/in-memory-store.ts";
import { createTools } from "../agents/tools.ts";
import { contextBreakdown, toolDefinitionsText } from "./breakdown.ts";
import { estimateTokens } from "./tokens.ts";

describe("contextBreakdown", () => {
  it("estimates each source and sums them (the spec example)", () => {
    assert.deepEqual(
      contextBreakdown({
        system: "s".repeat(400),
        tools: "t".repeat(800),
        history: "h".repeat(1000),
        memories: "",
        message: "m".repeat(40),
      }),
      { system: 100, tools: 200, history: 250, memories: 0, message: 10, total: 560 },
    );
  });

  it("is all zeros for empty texts", () => {
    assert.deepEqual(contextBreakdown({ system: "", tools: "", history: "", memories: "", message: "" }), {
      system: 0,
      tools: 0,
      history: 0,
      memories: 0,
      message: 0,
      total: 0,
    });
  });

  it("totals the parts, not the concatenation, so they always add up", () => {
    const texts = { system: "abc", tools: "abcde", history: "a", memories: "abcd", message: "xy" };
    const result = contextBreakdown(texts);
    assert.equal(result.total, result.system + result.tools + result.history + result.memories + result.message);
    // Each part rounds up on its own, so the sum can exceed the estimate of the joined text.
    assert.equal(result.total, 1 + 2 + 1 + 1 + 1);
    assert.ok(result.total > estimateTokens(Object.values(texts).join("")));
  });
});

describe("toolDefinitionsText", () => {
  it("is an empty JSON array for no tools", () => {
    assert.equal(toolDefinitionsText([]), "[]");
  });

  it("lists every tool with its name, description, and argument schema", () => {
    const tools = createTools(createStore());
    const parsed: unknown = JSON.parse(toolDefinitionsText(tools));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, tools.length);
    parsed.forEach((entry, index) => {
      const tool = tools[index];
      assert.equal(entry.type, "function");
      assert.equal(entry.function.name, tool?.name);
      assert.equal(entry.function.description, tool?.description);
      assert.equal(typeof entry.function.parameters, "object");
    });
  });
});
