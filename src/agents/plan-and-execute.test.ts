import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "../store/in-memory-store.ts";
import {
  ScriptedChatModel,
  textTurn,
  toolCallTurn,
  withUsage,
  type ScriptedTurn,
} from "../testing/scripted-chat-model.ts";
import { tool } from "@langchain/core/tools";
import { END } from "@langchain/langgraph";
import { z } from "zod";
import {
  afterExecutor,
  EXECUTOR_ATTEMPTS,
  applyReplan,
  cleanSteps,
  createPlanExecuteStrategy,
  PLAN_TOOL_NAME,
  REPLAN_TOOL_NAME,
  type Replan,
} from "./plan-and-execute.ts";
import { STRUCTURED_ATTEMPTS } from "./structured-output.ts";
import { createTools } from "./tools.ts";

const plan = (steps: string[]) => toolCallTurn(PLAN_TOOL_NAME, { steps });
const replan = (decision: Replan) => toolCallTurn(REPLAN_TOOL_NAME, decision);
const listFiring = toolCallTurn("list_alerts", { status: "firing" });
const openIncident = toolCallTurn("open_incident", {
  title: "Payments backlog",
  service: "payments-worker",
  severity: "critical",
});

/** A replanner that never finishes, scripted for a given number of executor passes. */
function endlessPlan(passes: number): ScriptedTurn[] {
  const again = replan({ action: "adjust", steps: ["Check again"] });
  return [plan(["Check again"]), ...Array.from({ length: passes }, () => [listFiring, again]).flat()];
}

function run(turns: ScriptedTurn[], maxIterations = 10) {
  const model = new ScriptedChatModel(turns);
  const strategy = createPlanExecuteStrategy({ model, tools: [...createTools(createStore())] });
  return { model, result: strategy.run("Open an incident for the worst firing alert", { maxIterations }) };
}

describe("applyReplan", () => {
  it("continue keeps the remaining plan without a plan event", () => {
    assert.deepEqual(applyReplan({ action: "continue" }, ["Open an incident"]), {
      plan: ["Open an incident"],
      trace: [],
    });
  });

  it("adjust replaces the plan and records it", () => {
    assert.deepEqual(applyReplan({ action: "adjust", steps: ["Resolve INC-001"] }, ["Open an incident"]), {
      plan: ["Resolve INC-001"],
      trace: [{ type: "plan", steps: ["Resolve INC-001"] }],
    });
  });

  it("finish answers even when steps remain", () => {
    assert.deepEqual(applyReplan({ action: "finish", answer: "Done." }, ["Open an incident"]), {
      plan: [],
      answer: "Done.",
      trace: [{ type: "answer", content: "Done." }],
    });
  });

  it("finishes when nothing is left to continue with", () => {
    assert.equal(applyReplan({ action: "continue" }, []).answer, "");
  });
});

describe("cleanSteps", () => {
  it("trims steps and drops ones without words", () => {
    assert.deepEqual(cleanSteps(["  List alerts ", ",", "", "Open incident"]), ["List alerts", "Open incident"]);
  });
});

describe("plan-execute strategy", () => {
  it("plans, executes one step at a time, and ends when the replanner finishes", async () => {
    const { model, result: pending } = run([
      plan(["List firing alerts", "Open an incident for the worst one"]),
      listFiring,
      replan({ action: "continue" }),
      openIncident,
      replan({ action: "finish", answer: "Opened INC-001 for payments-worker." }),
    ]);
    const result = await pending;

    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Opened INC-001 for payments-worker.");
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["plan", "action", "observation", "action", "observation", "answer"],
    );
    assert.equal(result.metrics.llmCalls, 5);
    assert.equal(result.metrics.llmCalls, model.calls);
  });

  it("adds a plan event when the replanner adjusts the remaining steps", async () => {
    const result = await run([
      plan(["List firing alerts"]),
      listFiring,
      replan({ action: "adjust", steps: ["Open an incident for payments-worker"] }),
      openIncident,
      replan({ action: "finish", answer: "Done." }),
    ]).result;

    const plans = result.trace.filter((event) => event.type === "plan");
    assert.deepEqual(plans[1], { type: "plan", steps: ["Open an incident for payments-worker"] });
  });

  it("goes to the replanner for the answer when the first plan is empty", async () => {
    const result = await run([plan([]), replan({ action: "finish", answer: "Nothing needs action." })]).result;

    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Nothing needs action.");
    assert.equal(result.trace.some((event) => event.type === "action"), false);
    assert.equal(result.metrics.llmCalls, 2);
  });

  it("stops at the step cap with iteration_limit", async () => {
    const { model, result: pending } = run(endlessPlan(2), 2);
    const result = await pending;

    assert.equal(result.stopReason, "iteration_limit");
    assert.equal(result.answer, null);
    assert.equal(result.trace.filter((event) => event.type === "action").length, 2);
    assert.equal(model.calls, 5);
  });

  it("caps steps at 8 even with a higher iteration limit", async () => {
    const result = await run(endlessPlan(8), 50).result;

    assert.equal(result.stopReason, "iteration_limit");
    assert.equal(result.trace.filter((event) => event.type === "action").length, 8);
  });

  it("retries once when the planner skips the structured tool call", async () => {
    const result = await run([
      textTurn("Here is my plan."),
      plan([" ", "List firing alerts"]),
      listFiring,
      replan({ action: "finish", answer: "Three alerts are firing." }),
    ]).result;

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.trace[0], { type: "plan", steps: ["List firing alerts"] });
    assert.equal(result.metrics.llmCalls, 4);
  });

  it("fails with a clear error when the structured output never arrives", async () => {
    const result = await run([textTurn("No plan.")]).result;

    assert.equal(result.stopReason, "error");
    assert.match(result.error.message, new RegExp(`planner returned no structured output after ${STRUCTURED_ATTEMPTS} attempts`));
  });

  it("keeps the partial trace when the model fails", async () => {
    const result = await run([plan(["List firing alerts"]), new Error("Provider unavailable")]).result;

    assert.equal(result.stopReason, "error");
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["plan"],
    );
  });
});

describe("plan-execute strategy: systemPrompt", () => {
  it("is the planner prompt with the tool list filled in, for both variants", () => {
    const model = new ScriptedChatModel([textTurn("x")]);
    const tools = [...createTools(createStore())];
    for (const options of [undefined, { replanner: false }]) {
      const { systemPrompt } = createPlanExecuteStrategy({ model, tools }, options);
      assert.ok(systemPrompt !== undefined);
      assert.equal(systemPrompt.includes("{tools}"), false);
      for (const tool of tools) assert.ok(systemPrompt.includes(`- ${tool.name}: ${tool.description}`));
    }
  });
});

describe("plan-execute strategy: prompt tokens", () => {
  const script = (usage: (turn: ScriptedTurn, tokens: number) => ScriptedTurn): ScriptedTurn[] =>
    [
      plan(["List firing alerts", "Open an incident for the worst one"]),
      listFiring,
      replan({ action: "continue" }),
      openIncident,
      replan({ action: "finish", answer: "Opened INC-001 for payments-worker." }),
    ].map((turn, index) => usage(turn, (index + 1) * 100));

  const measured = (turn: ScriptedTurn, tokens: number) => withUsage(turn as never, tokens);

  it("sums the planner, executor, and replanner calls", async () => {
    const result = await run(script(measured)).result;
    assert.equal(result.stopReason, "completed");
    assert.equal(result.metrics.llmCalls, 5);
    assert.equal(result.metrics.promptTokens, 1500);
  });

  it("does not change the answer, trace, stop reason, or call count", async () => {
    const plain = await run(script((turn) => turn)).result;
    const withTokens = await run(script(measured)).result;

    assert.equal(withTokens.stopReason, plain.stopReason);
    assert.equal(withTokens.answer, plain.answer);
    assert.deepEqual(withTokens.trace, plain.trace);
    assert.equal(withTokens.metrics.llmCalls, plain.metrics.llmCalls);
  });

  it("is null when no call reported usage", async () => {
    const result = await run(script((turn) => turn)).result;
    assert.equal(result.metrics.promptTokens, null);
  });

  it("sums the same way without a replanner", async () => {
    const model = new ScriptedChatModel([
      withUsage(plan(["List firing alerts", "Open an incident for payments-worker"]), 100),
      withUsage(listFiring, 200),
      withUsage(openIncident, 300),
      withUsage(textTurn("Opened INC-001 for payments-worker."), 400),
    ]);
    const strategy = createPlanExecuteStrategy(
      { model, tools: [...createTools(createStore())] },
      { replanner: false },
    );
    const result = await strategy.run("Open an incident for the worst firing alert", { maxIterations: 10 });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.metrics.promptTokens, 1000);
  });
});

describe("afterExecutor", () => {
  const options = { replanner: false, stepCap: 2 };

  it("always goes to the replanner when it is on", () => {
    assert.equal(afterExecutor({ plan: [], done: [] }, { ...options, replanner: true }), "replanner");
  });

  it("without a replanner, runs the next step, answers when the plan is done, and stops at the cap", () => {
    assert.equal(afterExecutor({ plan: ["Next"], done: [1] }, options), "executor");
    assert.equal(afterExecutor({ plan: [], done: [1, 2] }, options), "responder");
    assert.equal(afterExecutor({ plan: ["Next"], done: [1, 2] }, options), END);
  });
});

describe("plan-execute without a replanner", () => {
  it("runs the first plan as is, then writes the answer in one call", async () => {
    const model = new ScriptedChatModel([
      plan(["List firing alerts", "Open an incident for payments-worker"]),
      listFiring,
      openIncident,
      textTurn("Opened INC-001 for payments-worker."),
    ]);
    const strategy = createPlanExecuteStrategy(
      { model, tools: [...createTools(createStore())] },
      { replanner: false },
    );
    assert.equal(strategy.name, "plan-execute:no-replanner");
    const result = await strategy.run("Open an incident for the worst firing alert", { maxIterations: 10 });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Opened INC-001 for payments-worker.");
    assert.equal(result.metrics.llmCalls, 4);
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["plan", "action", "observation", "action", "observation", "answer"],
    );
  });

  it("stops at the step cap without an answer", async () => {
    const model = new ScriptedChatModel([plan(["One", "Two", "Three"]), listFiring]);
    const strategy = createPlanExecuteStrategy(
      { model, tools: [...createTools(createStore())] },
      { replanner: false },
    );
    const result = await strategy.run("Check three times", { maxIterations: 2 });
    assert.equal(result.stopReason, "iteration_limit");
    assert.equal(result.metrics.llmCalls, 3);
  });
});

describe("plan-execute executor retry", () => {
  it("re-asks the executor when a step reply has no tool call", async () => {
    const { model, result } = run([
      plan(["List firing alerts"]),
      textTurn("I have no access to your alerts."),
      listFiring,
      replan({ action: "finish", answer: "Four alerts are firing." }),
    ]);
    const outcome = await result;
    assert.equal(outcome.answer, "Four alerts are firing.");
    assert.equal(outcome.trace.filter((event) => event.type === "action").length, 1);
    assert.equal(outcome.metrics.llmCalls, 4);
    assert.equal(model.calls, 4);
  });

  it("records the text after EXECUTOR_ATTEMPTS replies without a tool call", async () => {
    const { result } = run([
      plan(["Summarize"]),
      ...Array.from({ length: EXECUTOR_ATTEMPTS }, () => textTurn("Nothing to do.")),
      replan({ action: "finish", answer: "Done." }),
    ]);
    const outcome = await result;
    assert.deepEqual(outcome.trace[1], { type: "thought", content: "Nothing to do." });
    assert.equal(outcome.metrics.llmCalls, 1 + EXECUTOR_ATTEMPTS + 1);
  });
});

describe("plan-execute strategy: abort signal", () => {
  it("makes no planner call when the signal is already aborted", async () => {
    const model = new ScriptedChatModel([plan(["List alerts"])]);
    const controller = new AbortController();
    controller.abort();
    const strategy = createPlanExecuteStrategy({ model, tools: [...createTools(createStore())] });

    const result = await strategy.run("hi", { maxIterations: 10, signal: controller.signal });

    assert.equal(result.stopReason, "error");
    assert.equal(model.calls, 0);
  });

  it("runs no later step and makes no model call after a tool aborts", async () => {
    const controller = new AbortController();
    let secondCalls = 0;
    const first = tool(
      async () => {
        controller.abort();
        return "first done";
      },
      { name: "first", description: "Aborts the run", schema: z.object({}) },
    );
    const second = tool(
      async () => {
        secondCalls += 1;
        return "second done";
      },
      { name: "second", description: "Must never run", schema: z.object({}) },
    );
    const model = new ScriptedChatModel([
      plan(["Run first", "Run second"]),
      toolCallTurn("first", {}),
      toolCallTurn("second", {}),
    ]);
    const strategy = createPlanExecuteStrategy({ model, tools: [first, second] });

    const result = await strategy.run("hi", { maxIterations: 10, signal: controller.signal });

    assert.equal(result.stopReason, "error");
    assert.equal(secondCalls, 0);
    assert.equal(model.calls, 2, "planner and the first executor turn only");
  });
});
