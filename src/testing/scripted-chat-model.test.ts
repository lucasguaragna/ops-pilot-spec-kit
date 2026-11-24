import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { promptTokensOf } from "../context/tokens.ts";
import { hangingTurn, ScriptedChatModel, textTurn, toolCallTurn, withUsage } from "./scripted-chat-model.ts";

describe("ScriptedChatModel: hangingTurn", () => {
  it("stays pending until the call's signal aborts, then rejects", async () => {
    const model = new ScriptedChatModel([hangingTurn()]);
    const controller = new AbortController();
    let settled = false;
    const call = model.invoke([new HumanMessage("hi")], { signal: controller.signal }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    controller.abort();
    await assert.rejects(call);
    assert.equal(model.calls, 1);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const model = new ScriptedChatModel([hangingTurn()]);
    await assert.rejects(model.invoke([new HumanMessage("hi")], { signal: AbortSignal.abort() }));
  });

  it("serves the next scripted turn on the next call", async () => {
    const model = new ScriptedChatModel([hangingTurn(), textTurn("done")]);
    const controller = new AbortController();
    const first = model.invoke([new HumanMessage("hi")], { signal: controller.signal });
    controller.abort();
    await assert.rejects(first);

    const second = await model.invoke([new HumanMessage("again")]);
    assert.equal(second.content, "done");
    assert.equal(model.calls, 2);
  });
});

describe("ScriptedChatModel: withUsage", () => {
  /** Collects what handleLLMEnd receives for each finished call. */
  class Collector extends BaseCallbackHandler {
    name = "collector";
    outputs: LLMResult[] = [];
    constructor() {
      super();
      this.awaitHandlers = true;
    }
    override handleLLMEnd(output: LLMResult): void {
      this.outputs.push(output);
    }
  }

  it("returns the scripted input usage on the message", async () => {
    const model = new ScriptedChatModel([withUsage(textTurn("hi"), 120)]);
    const message = await model.invoke([new HumanMessage("hello")]);
    assert.equal(message.usage_metadata?.input_tokens, 120);
    assert.equal(message.content, "hi");
  });

  it("keeps the tool calls of the turn it wraps", () => {
    const turn = withUsage(toolCallTurn("list_alerts", { status: "firing" }), 10);
    assert.equal(turn.tool_calls?.[0]?.name, "list_alerts");
  });

  it("reports the usage to handleLLMEnd, and nothing for a turn without usage", async () => {
    const model = new ScriptedChatModel([withUsage(textTurn("a"), 120), textTurn("b")]);
    const collector = new Collector();
    await model.invoke([new HumanMessage("one")], { callbacks: [collector] });
    await model.invoke([new HumanMessage("two")], { callbacks: [collector] });
    assert.deepEqual(
      collector.outputs.map((output) => promptTokensOf(output)),
      [120, undefined],
    );
  });
});
