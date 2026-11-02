import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { messagesToTrace } from "./from-messages.ts";

describe("messagesToTrace", () => {
  it("maps a tool-using conversation to ordered events", () => {
    const trace = messagesToTrace([
      new HumanMessage("What is firing?"),
      new AIMessage({
        content: "I will list firing alerts.",
        tool_calls: [{ id: "1", name: "list_alerts", args: { status: "firing" }, type: "tool_call" }],
      }),
      new ToolMessage({ content: "[]", tool_call_id: "1", name: "list_alerts" }),
      new AIMessage("Nothing is firing."),
    ]);

    assert.deepEqual(trace, [
      { type: "thought", content: "I will list firing alerts." },
      { type: "action", tool: "list_alerts", args: { status: "firing" } },
      { type: "observation", tool: "list_alerts", content: "[]" },
      { type: "answer", content: "Nothing is firing." },
    ]);
  });

  it("emits one action per tool call and skips empty thoughts", () => {
    const trace = messagesToTrace([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "a", name: "list_alerts", args: {}, type: "tool_call" },
          { id: "b", name: "resolve_incident", args: { id: "INC-001" }, type: "tool_call" },
        ],
      }),
    ]);
    assert.deepEqual(
      trace.map((event) => event.type),
      ["action", "action"],
    );
  });

  it("names the observation by its tool call when the message has no name", () => {
    const trace = messagesToTrace([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "x", name: "list_alerts", args: {}, type: "tool_call" }],
      }),
      new ToolMessage({ content: "[]", tool_call_id: "x" }),
    ]);
    assert.deepEqual(trace[1], { type: "observation", tool: "list_alerts", content: "[]" });
  });
});
