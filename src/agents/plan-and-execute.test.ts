import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "../store/in-memory-store.ts";
import { ScriptedChatModel, toolCallTurn, type ScriptedTurn } from "../testing/scripted-chat-model.ts";
import { createPlanExecuteStrategy, PLAN_TOOL_NAME } from "./plan-and-execute.ts";
import { createTools } from "./tools.ts";

const decision = (steps: string[], answer?: string) => toolCallTurn(PLAN_TOOL_NAME, { steps, answer });
const listFiring = toolCallTurn("list_alerts", { status: "firing" });
const openIncident = toolCallTurn("open_incident", {
  title: "Payments backlog",
  service: "payments-worker",
  severity: "critical",
});

/** A planner that never runs out of steps, scripted for a given number of executor passes. */
function endlessPlan(passes: number): ScriptedTurn[] {
  const again = decision(["Check again"]);
  return [again, ...Array.from({ length: passes }, () => [listFiring, again]).flat()];
}

function run(turns: ScriptedTurn[], maxIterations = 10) {
  const model = new ScriptedChatModel(turns);
  const strategy = createPlanExecuteStrategy({ model, tools: [...createTools(createStore())] });
  return { model, result: strategy.run("Open an incident for the worst firing alert", { maxIterations }) };
}

describe("plan-execute strategy", () => {
  it("plans first, runs one step per action, and ends when the replanner has no steps", async () => {
    const { model, result: pending } = run([
      decision(["List firing alerts", "Open an incident for the worst one"]),
      listFiring,
      decision(["Open an incident for the worst one"]),
      openIncident,
      decision([], "Opened INC-001 for payments-worker."),
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

  it("adds a plan event when the replanner changes the remaining steps", async () => {
    const result = await run([
      decision(["List firing alerts"]),
      listFiring,
      decision(["Open an incident for payments-worker"]),
      openIncident,
      decision([], "Done."),
    ]).result;

    const plans = result.trace.filter((event) => event.type === "plan");
    assert.deepEqual(plans[1], { type: "plan", steps: ["Open an incident for payments-worker"] });
  });

  it("ends with an answer and no steps when the plan is empty", async () => {
    const result = await run([decision([], "Nothing needs action.")]).result;

    assert.equal(result.stopReason, "completed");
    assert.equal(result.answer, "Nothing needs action.");
    assert.equal(result.trace.some((event) => event.type === "action"), false);
    assert.equal(result.metrics.llmCalls, 1);
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

  it("keeps the partial trace when the model fails", async () => {
    const result = await run([decision(["List firing alerts"]), new Error("Provider unavailable")]).result;

    assert.equal(result.stopReason, "error");
    assert.deepEqual(
      result.trace.map((event) => event.type),
      ["plan"],
    );
  });
});
