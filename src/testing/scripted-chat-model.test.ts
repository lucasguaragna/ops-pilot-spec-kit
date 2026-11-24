import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { hangingTurn, ScriptedChatModel, textTurn } from "./scripted-chat-model.ts";

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
