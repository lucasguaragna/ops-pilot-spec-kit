import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SummarizationStep } from "../agents/history-summarizer.ts";
import { composeInput } from "../agents/history.ts";
import { fallbackEvents } from "../agents/llm-counter.ts";
import { composeMemoryInput } from "../agents/memories.ts";
import { addPromptTokens } from "../context/tokens.ts";
import type { Memory, NewMessage } from "../domain/schemas.ts";
import type { NodeTraceEvent, ReasoningStrategy, Route, RouteDecision, RunResult } from "../domain/types.ts";
import { finalizeTrace, tagNode } from "./node-trace.ts";
import type { Router } from "./router.ts";
import { decideRoute, routeOf } from "./routing.ts";

export interface ProductionGraphDependencies {
  router: Router;
  /** Lazy: only the chosen route's strategy is built. */
  strategyFor: (route: Route) => ReasoningStrategy;
  /** The summarization step, or a constant `not_due` one. Never throws. */
  summarize: () => Promise<SummarizationStep>;
  maxIterations: number;
}

export interface ProductionGraphInput {
  message: string;
  /** The route the caller forced, or undefined when the router decides. */
  override: Route | undefined;
  recalled: readonly Pick<Memory, "id" | "fact">[];
  /** The messages that go word for word when the summarization stores a new summary. */
  verbatim: readonly NewMessage[];
  /** The messages that go word for word when it does not (not due, or failed). */
  fallbackHistory: readonly NewMessage[];
  /** The rendered previous summary, or "". */
  previousSummary: string;
}

export interface ProductionGraphResult {
  result: RunResult<NodeTraceEvent>;
  decision: RouteDecision;
  /** The messages the agent read word for word. */
  history: NewMessage[];
  /** The rendered summary the agent read. */
  summaryText: string;
  step: SummarizationStep;
}

const keep = <T>() => Annotation<T>;

const GraphState = Annotation.Root({
  message: keep<string>(),
  override: keep<Route | undefined>(),
  recalled: keep<readonly Pick<Memory, "id" | "fact">[]>(),
  verbatim: keep<readonly NewMessage[]>(),
  fallbackHistory: keep<readonly NewMessage[]>(),
  previousSummary: keep<string>(),
  input: keep<string>(),
  history: keep<NewMessage[]>(),
  summaryText: keep<string>(),
  step: keep<SummarizationStep>(),
  decision: keep<RouteDecision | undefined>(),
  strategyResult: keep<RunResult | undefined>(),
  result: keep<RunResult<NodeTraceEvent> | undefined>(),
  trace: Annotation<NodeTraceEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  llmCalls: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  promptTokens: Annotation<number | null>({ reducer: addPromptTokens, default: () => null }),
  // The model of the newest call that got an answer; a node that had none keeps the earlier value.
  modelUsed: Annotation<string | null>({ reducer: (earlier, latest) => latest ?? earlier, default: () => null }),
});
type State = typeof GraphState.State;

/**
 * Builds and runs the graph for one request:
 * `START -> context -> router -> { react | plan-execute | reflect } -> response -> END`.
 *
 * Rejects when a strategy throws or the signal aborts. The router and the summarization never reject.
 */
export async function runProductionGraph(
  dependencies: ProductionGraphDependencies,
  input: ProductionGraphInput,
  { signal }: { signal?: AbortSignal },
): Promise<ProductionGraphResult> {
  const { router, strategyFor, summarize, maxIterations } = dependencies;
  const started = Date.now();

  const contextNode = async (state: State) => {
    const step = await summarize();
    const stored = step.kind === "stored";
    const history = [...(stored ? state.verbatim : state.fallbackHistory)];
    const summaryText = stored ? step.rendered : state.previousSummary;
    return {
      step,
      history,
      summaryText,
      input: composeMemoryInput(state.recalled, composeInput(history, state.message, summaryText)),
      trace: tagNode(
        [
          ...(step.kind === "not_due" ? [] : fallbackEvents(step.switches)),
          ...(stored ? [{ type: "summarize" as const, content: step.rendered, absorbed: step.absorbed }] : []),
        ],
        "context",
      ),
      llmCalls: step.kind === "not_due" ? 0 : step.llmCalls,
      promptTokens: step.kind === "not_due" ? null : step.promptTokens,
      modelUsed: step.kind === "not_due" ? null : step.modelUsed,
    };
  };

  const routerNode = async (state: State, config: RunnableConfig) => {
    const spent =
      state.override === undefined
        ? await router.route(state.input, { signal: config.signal })
        : {
            decision: decideRoute({ kind: "override", route: state.override }),
            llmCalls: 0,
            promptTokens: null,
            switches: [],
            modelUsed: null,
          };
    const { decision } = spent;
    return {
      decision,
      trace: tagNode([...fallbackEvents(spent.switches), { type: "route", ...decision }], "router"),
      llmCalls: spent.llmCalls,
      promptTokens: spent.promptTokens,
      modelUsed: spent.modelUsed,
    };
  };

  const strategyNode = (route: Route) => async (state: State, config: RunnableConfig) => {
    const result = await strategyFor(route).run(state.input, { maxIterations, signal: config.signal });
    return {
      strategyResult: result,
      trace: finalizeTrace(route, result),
      llmCalls: result.metrics.llmCalls,
      promptTokens: result.metrics.promptTokens,
      modelUsed: result.metrics.modelUsed,
    };
  };

  const responseNode = (state: State) => {
    const strategy = state.strategyResult as RunResult;
    const metrics = { llmCalls: state.llmCalls, latencyMs: 0, promptTokens: state.promptTokens, modelUsed: state.modelUsed };
    return { result: { ...strategy, trace: state.trace, metrics } as RunResult<NodeTraceEvent> };
  };

  const graph = new StateGraph(GraphState)
    .addNode("context", contextNode)
    .addNode("router", routerNode)
    .addNode("react", strategyNode("react"))
    .addNode("plan-execute", strategyNode("plan-execute"))
    .addNode("reflect", strategyNode("reflect"))
    .addNode("response", responseNode)
    .addEdge(START, "context")
    .addEdge("context", "router")
    .addConditionalEdges("router", routeOf, { react: "react", "plan-execute": "plan-execute", reflect: "reflect" })
    .addEdge("react", "response")
    .addEdge("plan-execute", "response")
    .addEdge("reflect", "response")
    .addEdge("response", END)
    .compile();

  const final = await graph.invoke(input, { signal });
  const result = final.result as RunResult<NodeTraceEvent>;
  return {
    result: { ...result, metrics: { ...result.metrics, latencyMs: Date.now() - started } },
    decision: final.decision as RouteDecision,
    history: final.history,
    summaryText: final.summaryText,
    step: final.step,
  };
}
