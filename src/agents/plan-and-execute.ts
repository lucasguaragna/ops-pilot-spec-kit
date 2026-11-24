import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage, type ToolCall } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { ReasoningStrategy, RunResult, TraceEvent } from "../domain/types.ts";
import { LlmCallCounter } from "./llm-counter.ts";
import type { StrategyDependencies } from "./react.ts";
import { isIterationLimitError, toRunError } from "./run-outcome.ts";
import { structured } from "./structured-output.ts";

export const MAX_STEPS = 8;
/** Executor calls per step while the reply has no tool call. */
export const EXECUTOR_ATTEMPTS = 3;
export const PLAN_TOOL_NAME = "plan";
export const REPLAN_TOOL_NAME = "replan";

const planSchema = z.object({
  steps: z.array(z.string()).describe("Short, ordered steps, each doable with the available tools."),
});

const replanSchema = z.object({
  action: z
    .enum(["continue", "adjust", "finish"])
    .describe("continue: keep the remaining plan. adjust: replace it with steps. finish: answer now."),
  steps: z.array(z.string()).optional().describe("The new remaining steps. Only for adjust."),
  answer: z.string().optional().describe("The final answer for the user. Only for finish."),
});
export type Replan = z.infer<typeof replanSchema>;

/** A completed step and what it produced. */
type Done = [step: string, result: string];

const PEState = Annotation.Root({
  input: Annotation<string>,
  plan: Annotation<string[]>,
  done: Annotation<Done[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  answer: Annotation<string | undefined>,
  trace: Annotation<TraceEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type PEState = typeof PEState.State;

const PLANNER_PROMPT =
  "You are OpsPilot's planner for production alerts and incidents. Break the request into the " +
  "fewest short steps, each one doable with a single round of calls to these tools only:\n" +
  "{tools}\nWrite each step as a plain instruction that names every value the tool needs, not as a " +
  "function call. When the request names services or alerts loosely, start with a step that lists " +
  "the alerts, so later steps use exact names. Keep the order the user asked for. Every step must " +
  "call a tool: never add a step that only reports, counts, or summarizes, since the final answer " +
  "covers that. Return no steps when nothing needs doing.";

const EXECUTOR_PROMPT =
  "You are OpsPilot's executor. Complete only the current step, calling the tools it needs. Never " +
  "do work that belongs to a later step: a step about one incident opens or resolves only that " +
  "incident. Use the results of the completed steps for any names or identifiers. When the step " +
  "needs no tool, reply with its result in one or two sentences.";

const REPLANNER_PROMPT =
  "You are OpsPilot's replanner. Review the completed steps against the request. Choose continue " +
  "when the remaining plan still fits, adjust with the new remaining steps when it does not, and " +
  "drop any step the completed results already cover. When a step failed and its result shows how " +
  "to fix it, such as a list of known names, adjust with a corrected step instead of skipping it. " +
  "Never swap a service the user named for a different one: when it does not exist, drop that " +
  "step, keep the rest, and report it in the final answer. Choose finish only when no remaining " +
  "step can still be done: an action the request asks for, such as opening or resolving an " +
  "incident, is done only when a completed result shows it. Never add a step that only reports or " +
  "counts; once every action has its result, finish and put the report in the answer. The final answer states only what the completed results show; never " +
  "say something was opened or resolved without a result that proves it.";

const RESPONDER_PROMPT =
  "You are OpsPilot. Write the final answer to the request from the completed steps, briefly. " +
  "State only what the results show; never say something was opened or resolved without a " +
  "result that proves it.";

export interface PlanExecuteOptions {
  /** When false, the executor runs the first plan as is and a responder writes the answer. */
  replanner?: boolean;
}

/** Where the graph goes after the executor, given the state left by the step. */
export function afterExecutor(
  state: { plan: readonly string[]; done: readonly unknown[] },
  { replanner, stepCap }: { replanner: boolean; stepCap: number },
): "replanner" | "executor" | "responder" | typeof END {
  if (replanner) return "replanner";
  if (state.plan.length === 0) return "responder";
  return state.done.length >= stepCap ? END : "executor";
}

function describeDone(done: readonly Done[]): string {
  if (done.length === 0) return "(none)";
  return done.map(([step, result], index) => `${index + 1}. ${step}\n   Result: ${result}`).join("\n");
}

function describePlan(plan: readonly string[]): string {
  return plan.length > 0 ? plan.map((step) => `- ${step}`).join("\n") : "(none)";
}

/** Drops blank steps, which weaker models sometimes emit. */
export function cleanSteps(steps: readonly string[]): string[] {
  return steps.map((step) => step.trim()).filter((step) => /\w/.test(step));
}

/** Turns a replanner decision into a state update. `remaining` is the plan left after the last step. */
export function applyReplan(decision: Replan, remaining: readonly string[]): Partial<PEState> {
  const plan = decision.action === "adjust" ? cleanSteps(decision.steps ?? []) : [...remaining];
  if (decision.action === "finish" || plan.length === 0) {
    const answer = decision.answer ?? "";
    return { plan: [], answer, trace: [{ type: "answer", content: answer }] };
  }
  const changed = JSON.stringify(plan) !== JSON.stringify(remaining);
  return { plan, trace: changed ? [{ type: "plan", steps: plan }] : [] };
}

export function createPlanExecuteStrategy(
  { model, tools }: StrategyDependencies,
  { replanner: useReplanner = true }: PlanExecuteOptions = {},
): ReasoningStrategy {
  if (!model.bindTools) throw new Error("The model must support tool calling");
  // Function calling works on every OpenRouter model with tools, unlike JSON schema mode.
  // includeRaw turns a missing or broken tool call into `parsed: null` instead of a throw,
  // so provider failures still throw while bad output can be retried.
  const planner = model.withStructuredOutput(planSchema, {
    name: PLAN_TOOL_NAME,
    method: "functionCalling",
    includeRaw: true,
  });
  const replanner = model.withStructuredOutput(replanSchema, {
    name: REPLAN_TOOL_NAME,
    method: "functionCalling",
    includeRaw: true,
  });
  const executor = model.bindTools(tools);
  const toolsByName = new Map<string, StructuredToolInterface>(tools.map((tool) => [tool.name, tool]));
  const plannerPrompt = PLANNER_PROMPT.replace(
    "{tools}",
    tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n"),
  );

  async function runToolCall(call: ToolCall, config: RunnableConfig): Promise<string> {
    const tool = toolsByName.get(call.name);
    if (!tool) return `Error: unknown tool ${call.name}`;
    try {
      const output: unknown = await tool.invoke(call.args, config);
      return typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      // An abort must stop the run, not become an observation the model reads.
      if (config.signal?.aborted) throw error;
      return `Error: ${toRunError(error).message}`;
    }
  }

  function buildGraph(stepCap: number) {
    return new StateGraph(PEState)
      .addNode("planner", async (state, config) => {
        const decision = await structured("planner", planSchema, () =>
          planner.invoke([new SystemMessage(plannerPrompt), new HumanMessage(state.input)], config),
        );
        const steps = cleanSteps(decision.steps);
        return { plan: steps, trace: [{ type: "plan", steps }] };
      })
      .addNode("executor", async (state, config) => {
        const [step = "", ...rest] = state.plan;
        const request =
          `Request: ${state.input}\n\nCompleted steps:\n${describeDone(state.done)}\n\n` +
          `Current step: ${step}\n\nLater steps, not yours:\n${describePlan(rest)}`;
        const messages = [new SystemMessage(EXECUTOR_PROMPT), new HumanMessage(request)];
        // Steps always need a tool, so a text-only reply is usually a routed model ignoring the tools.
        let response = await executor.invoke(messages, config);
        for (let attempt = 1; attempt < EXECUTOR_ATTEMPTS && (response.tool_calls?.length ?? 0) === 0; attempt++) {
          response = await executor.invoke(messages, config);
        }
        const trace: TraceEvent[] = [];
        const observations: string[] = [];
        for (const call of response.tool_calls ?? []) {
          const content = await runToolCall(call, config);
          trace.push({ type: "action", tool: call.name, args: call.args });
          trace.push({ type: "observation", tool: call.name, content });
          observations.push(content);
        }
        if (observations.length === 0 && response.text) trace.push({ type: "thought", content: response.text });
        const done: Done = [step, observations.join("\n") || response.text];
        return { plan: rest, done: [done], trace };
      })
      .addNode("replanner", async (state, config) => {
        const request =
          `Request: ${state.input}\n\nCompleted steps:\n${describeDone(state.done)}\n\n` +
          `Remaining plan:\n${describePlan(state.plan)}`;
        const decision = await structured("replanner", replanSchema, () =>
          replanner.invoke([new SystemMessage(REPLANNER_PROMPT), new HumanMessage(request)], config),
        );
        return applyReplan(decision, state.plan);
      })
      .addNode("responder", async (state, config) => {
        const request = `Request: ${state.input}\n\nCompleted steps:\n${describeDone(state.done)}`;
        const response = await model.invoke([new SystemMessage(RESPONDER_PROMPT), new HumanMessage(request)], config);
        return { answer: response.text, trace: [{ type: "answer", content: response.text }] };
      })
      .addEdge(START, "planner")
      // An empty first plan goes straight to whichever node writes the answer.
      .addConditionalEdges(
        "planner",
        (state) => (state.plan.length > 0 ? "executor" : useReplanner ? "replanner" : "responder"),
        ["executor", "replanner", "responder"],
      )
      .addConditionalEdges("executor", (state) => afterExecutor(state, { replanner: useReplanner, stepCap }), [
        "replanner",
        "executor",
        "responder",
        END,
      ])
      .addEdge("responder", END)
      .addConditionalEdges(
        "replanner",
        (state) => (state.answer !== undefined || state.done.length >= stepCap ? END : "executor"),
        ["executor", END],
      )
      .compile();
  }

  return {
    name: useReplanner ? "plan-execute" : "plan-execute:no-replanner",
    // The first model call is the planner's, and its prompt already lists the tools.
    systemPrompt: plannerPrompt,
    async run(input, { maxIterations, signal }): Promise<RunResult> {
      const started = Date.now();
      const counter = new LlmCallCounter();
      const stepCap = Math.min(maxIterations, MAX_STEPS);
      const graph = buildGraph(stepCap);

      let state: PEState | undefined;
      const outcome = await (async () => {
        try {
          const stream = await graph.stream(
            { input, plan: [] },
            // Safety net only; the step cap on `done` is the real limit.
            { streamMode: "values", callbacks: [counter], recursionLimit: stepCap * 2 + 10, signal },
          );
          for await (const values of stream) state = values;
          return state?.answer === undefined
            ? ({ stopReason: "iteration_limit" } as const)
            : ({ stopReason: "completed" } as const);
        } catch (error) {
          return isIterationLimitError(error)
            ? ({ stopReason: "iteration_limit" } as const)
            : ({ stopReason: "error", error: toRunError(error) } as const);
        }
      })();

      const trace = state?.trace ?? [];
      const metrics = {
        llmCalls: counter.count,
        latencyMs: Date.now() - started,
        promptTokens: counter.promptTokens,
      };
      if (outcome.stopReason === "completed") {
        return { stopReason: "completed", answer: state?.answer ?? "", trace, metrics };
      }
      return { ...outcome, answer: null, trace, metrics };
    },
  };
}
