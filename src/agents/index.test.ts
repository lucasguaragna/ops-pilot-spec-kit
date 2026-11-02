import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { UnknownStrategyError } from "../domain/errors.ts";
import type { ReasoningStrategy, RunResult } from "../domain/types.ts";
import { ScriptedChatModel, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { VERDICT_TOOL_NAME } from "./reflection.ts";
import { createStrategy, strategyFactories, type StrategyRegistry } from "./index.ts";

const stub = (name: string): ReasoningStrategy => ({
  name,
  run: async () => {
    throw new Error("not run in this test");
  },
});

const registry: StrategyRegistry = {
  react: () => stub("react"),
  "plan-execute": () => stub("plan-execute"),
};
const dependencies = { model: {} as BaseChatModel, tools: [] };

describe("createStrategy", () => {
  it("returns the strategy registered under the name", () => {
    assert.equal(createStrategy(registry, "react", dependencies, { reflect: false }).name, "react");
    assert.equal(createStrategy(registry, "plan-execute", dependencies, { reflect: false }).name, "plan-execute");
  });

  for (const name of ["chain-of-thought", "React", "reflect:react", "toString", "constructor"]) {
    it(`rejects "${name}" with the known names`, () => {
      assert.throws(
        () => createStrategy(registry, name, dependencies, { reflect: false }),
        (error: unknown) =>
          error instanceof UnknownStrategyError &&
          error.strategy === name &&
          JSON.stringify(error.knownStrategies) === JSON.stringify(["react", "plan-execute"]),
      );
    });
  }
});

describe("strategyFactories", () => {
  it("holds exactly the base strategies", () => {
    assert.deepEqual(Object.keys(strategyFactories), ["react", "plan-execute"]);
  });
});

describe("createStrategy with reflection", () => {
  const done: RunResult = {
    stopReason: "completed",
    answer: "ok",
    trace: [{ type: "answer", content: "ok" }],
    metrics: { llmCalls: 1, latencyMs: 0 },
  };
  const base: ReasoningStrategy = { name: "react", run: async () => done };

  it("wraps the base strategy so its run calls the base and the critic", async () => {
    const model = new ScriptedChatModel([toolCallTurn(VERDICT_TOOL_NAME, { approved: true, feedback: "ok" })]);
    const strategy = createStrategy({ react: () => base }, "react", { model, tools: [] }, { reflect: true });

    const result = await strategy.run("hi", { maxIterations: 10 });

    assert.equal(strategy.name, "reflect:react");
    assert.equal(model.calls, 1);
    assert.ok(result.trace.some((event) => event.type === "critique"));
  });

  it("returns the plain strategy when reflect is false", () => {
    const strategy = createStrategy({ react: () => base }, "react", dependencies, { reflect: false });
    assert.equal(strategy.name, "react");
  });
});
