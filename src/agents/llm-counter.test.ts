import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedChatModel, textTurn } from "../testing/scripted-chat-model.ts";
import { LlmCallCounter } from "./llm-counter.ts";

describe("LlmCallCounter", () => {
  it("counts every call made through a model", async () => {
    const model = new ScriptedChatModel([textTurn("one"), textTurn("two"), textTurn("three")]);
    const counter = new LlmCallCounter();
    for (let call = 0; call < 3; call += 1) {
      await model.invoke("hello", { callbacks: [counter] });
    }
    assert.equal(counter.count, 3);
    assert.equal(counter.count, model.calls);
  });
});
