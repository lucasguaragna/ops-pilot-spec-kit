import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage, type ToolCall } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { ReasoningStrategy, RunResult, TraceEvent } from "../domain/types.ts";
import { LlmCallCounter } from "./llm-counter.ts";
import type { StrategyDependencies } from "./react.ts";
import { isIterationLimitError, toRunError } from "./run-outcome.ts";

export const MAX_STEPS = 8;
export const PLAN_TOOL_NAME = "plan";

const Decision = z.object({
  steps: z.array(z.string()).describe("Steps still to do, in order. Empty when the request is done."),
  answer: z.string().optional().describe("Final answer for the user. Required when steps is empty."),
});
type Decision = z.infer<typeof Decision>;

interface StepResult {
  step: string;
  result: string;
}

const PlanState = Annotation.Root({
  input: Annotation<string>,
  plan: Annotation<string[]>,
  pastSteps: Annotation<StepResult[]>,
  answer: Annotation<string | null>,
  limitReached: Annotation<boolean>,
  trace: Annotation<TraceEvent[]>({ reducer: (current, next) => current.concat(next), default: () => [] }),
});
type PlanState = typeof PlanState.State;

const PLANNER_PROMPT =
  "You are OpsPilot's planner for production alerts and incidents. Break the request into the " +
  "fewest steps, each one doable with a single round of tool calls. If nothing needs doing, return " +
  "no steps and answer directly.";

const EXECUTOR_PROMPT =
  "You are OpsPilot's executor. Complete only the current step, using the tools when they help.";

const REPLANNER_PROMPT =
  "You are OpsPilot's replanner. Given the completed steps, return the steps that still need doing. " +
  "When the request is done, return no steps and the final answer for the user.";

function describeSteps(pastSteps: readonly StepResult[]): string {
  if (pastSteps.length === 0) return "(none)";
  return pastSteps.map(({ step, result }, index) => `${index + 1}. ${step}\n   Result: ${result}`).join("\n");
}

function executorRequest(state: PlanState, step: string): string {
  return `Request: ${state.input}\n\nCompleted steps:\n${describeSteps(state.pastSteps)}\n\nCurrent step: ${step}`;
}

function replannerRequest(state: PlanState): string {
  const remaining = state.plan.length > 0 ? state.plan.map((step) => `- ${step}`).join("\n") : "(none)";
  return (
    `Request: ${state.input}\n\nCompleted steps:\n${describeSteps(state.pastSteps)}\n\n` +
    `Remaining plan:\n${remaining}`
  );
}

/** Turns a planner or replanner decision into a state update. `current` is null for the first plan. */
export function applyDecision(
  decision: Decision,
  current: readonly string[] | null,
  stepsDone: number,
  stepCap: number,
): Partial<PlanState> {
  const changed = current === null || JSON.stringify(current) !== JSON.stringify(decision.steps);
  const planEvents: TraceEvent[] = changed ? [{ type: "plan", steps: decision.steps }] : [];
  if (decision.steps.length === 0) {
    const answer = decision.answer ?? "";
    return { plan: [], answer, trace: [...planEvents, { type: "answer", content: answer }] };
  }
  return { plan: decision.steps, limitReached: stepsDone >= stepCap, trace: planEvents };
}

export function createPlanExecuteStrategy({ model, tools }: StrategyDependencies): ReasoningStrategy {
  if (!model.bindTools) throw new Error("The model must support tool calling");
  const planner = model.withStructuredOutput(Decision, { name: PLAN_TOOL_NAME, method: "functionCalling" });
  const executor = model.bindTools(tools);
  const toolsByName = new Map<string, StructuredToolInterface>(tools.map((tool) => [tool.name, tool]));

  async function runToolCall(call: ToolCall, config: RunnableConfig): Promise<string> {
    const tool = toolsByName.get(call.name);
    if (!tool) return `Error: unknown tool ${call.name}`;
    try {
      const output: unknown = await tool.invoke(call.args, config);
      return typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      return `Error: ${toRunError(error).message}`;
    }
  }

  function buildGraph(stepCap: number) {
    return new StateGraph(PlanState)
      .addNode("planner", async (state, config) => {
        const decision = await planner.invoke(
          [new SystemMessage(PLANNER_PROMPT), new HumanMessage(state.input)],
          config,
        );
        return applyDecision(decision, null, 0, stepCap);
      })
      .addNode("executor", async (state, config) => {
        const [step = "", ...rest] = state.plan;
        const response = await executor.invoke(
          [new SystemMessage(EXECUTOR_PROMPT), new HumanMessage(executorRequest(state, step))],
          config,
        );
        const trace: TraceEvent[] = [];
        const observations: string[] = [];
        for (const call of response.tool_calls ?? []) {
          const content = await runToolCall(call, config);
          trace.push({ type: "action", tool: call.name, args: call.args });
          trace.push({ type: "observation", tool: call.name, content });
          observations.push(content);
        }
        if (observations.length === 0 && response.text) trace.push({ type: "thought", content: response.text });
        const result = observations.join("\n") || response.text;
        return { plan: rest, pastSteps: [...state.pastSteps, { step, result }], trace };
      })
      .addNode("replanner", async (state, config) => {
        const decision = await planner.invoke(
          [new SystemMessage(REPLANNER_PROMPT), new HumanMessage(replannerRequest(state))],
          config,
        );
        return applyDecision(decision, state.plan, state.pastSteps.length, stepCap);
      })
      .addEdge(START, "planner")
      .addConditionalEdges("planner", (state) => (state.answer === null ? "executor" : END), ["executor", END])
      .addEdge("executor", "replanner")
      .addConditionalEdges(
        "replanner",
        (state) => (state.answer !== null || state.limitReached ? END : "executor"),
        ["executor", END],
      )
      .compile();
  }

  return {
    name: "plan-execute",
    async run(input, { maxIterations }): Promise<RunResult> {
      const started = Date.now();
      const counter = new LlmCallCounter();
      const stepCap = Math.min(maxIterations, MAX_STEPS);
      const graph = buildGraph(stepCap);

      let state: PlanState | undefined;
      const outcome = await (async () => {
        try {
          const stream = await graph.stream(
            { input, plan: [], pastSteps: [], answer: null, limitReached: false },
            // Safety net only; the explicit step counter above is the real limit.
            { streamMode: "values", callbacks: [counter], recursionLimit: stepCap * 2 + 10 },
          );
          for await (const values of stream) state = values;
          return state?.limitReached
            ? ({ stopReason: "iteration_limit" } as const)
            : ({ stopReason: "completed" } as const);
        } catch (error) {
          return isIterationLimitError(error)
            ? ({ stopReason: "iteration_limit" } as const)
            : ({ stopReason: "error", error: toRunError(error) } as const);
        }
      })();

      const trace = state?.trace ?? [];
      const metrics = { llmCalls: counter.count, latencyMs: Date.now() - started };
      if (outcome.stopReason === "completed") {
        return { stopReason: "completed", answer: state?.answer ?? "", trace, metrics };
      }
      return { ...outcome, answer: null, trace, metrics };
    },
  };
}
