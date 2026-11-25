# Contract: Production graph module

## `src/graph/routing.ts` (pure)

```ts
export const ROUTES = ["react", "plan-execute", "reflect"] as const;
export const routeAnswerSchema: z.ZodType<{ route: Route; reason: string }>;
export const ROUTER_PROMPT: string;           // holds the routing table; every route appears in it
export const OVERRIDE_REASON = "Requested by the caller";
export const FALLBACK_ROUTE: Route = "react";

/** The caller's forced route, or undefined for "the router decides". Throws UnknownStrategyError. */
export function requestedRoute(request: { strategy?: string; reflect?: boolean }): Route | undefined;

/** What the router's call produced, as a decision. Never throws. */
export function decideRoute(
  outcome:
    | { kind: "override"; route: Route }
    | { kind: "answered"; parsed: unknown }
    | { kind: "thrown"; error: unknown },
): RouteDecision;

/** The conditional edge: the next node after the router. */
export function routeOf(state: { decision?: RouteDecision }): Route;
```

## `src/graph/node-trace.ts` (pure)

```ts
export function tagNode(events: readonly TraceEvent[], node: NodeName): NodeTraceEvent[];

/**
 * The strategy's trace tagged with its route, and on a completed run its last `answer` event moved to
 * the `response` node. Other stop reasons pass through, tagged.
 */
export function finalizeTrace(route: Route, result: RunResult): NodeTraceEvent[];
```

## `src/graph/router.ts`

```ts
export interface Router {
  /** One structured-output call. Rethrows only when the signal is aborted. */
  route(input: string, config: { signal?: AbortSignal }): Promise<{
    decision: RouteDecision; llmCalls: number; promptTokens: number | null;
  }>;
}
export function createRouter({ model }: { model: BaseChatModel }): Router;
```

## `src/graph/production-graph.ts`

```ts
export interface ProductionGraphDependencies {
  router: Router;
  /** Lazy: only the chosen route's strategy is built. */
  strategyFor: (route: Route) => ReasoningStrategy;
  /** The 011 summarization step, or a constant `not_due` one. Never throws. */
  summarize: () => Promise<SummarizationStep>;
  maxIterations: number;
}

export interface ProductionGraphInput {
  message: string;
  override: Route | undefined;
  recalled: readonly RecalledMemory[];
  /** What goes word for word if the summarization stores a new summary. */
  verbatim: readonly NewMessage[];
  /** What goes word for word if it does not (not due, or failed): today's capped fallback. */
  fallbackHistory: readonly NewMessage[];
  /** The rendered previous summary, or "". */
  previousSummary: string;
}

export function runProductionGraph(
  dependencies: ProductionGraphDependencies,
  input: ProductionGraphInput,
  options: { signal?: AbortSignal },
): Promise<ProductionGraphResult>;
```

### Node behaviour

| Node | Reads | Writes | Side effect |
| --- | --- | --- | --- |
| `context` | message, recalled, verbatim, fallbackHistory, previousSummary | input, history, summaryText, trace (`summarize`), llmCalls, promptTokens | `summarize()` |
| `router` | input, override | decision, trace (`route`), llmCalls, promptTokens | `router.route()` unless override |
| `react` / `plan-execute` / `reflect` | input | strategyResult, trace (tagged), llmCalls, promptTokens | `strategyFor(route).run(input, { maxIterations, signal })` |
| `response` | strategyResult, trace, sums | result | none |

Edges: `START -> context -> router`, then a conditional edge on `routeOf` to the three strategy
nodes, then each one `-> response -> END`.

The input composition is `composeMemoryInput(recalled, composeInput(history, message, summaryText))`,
so the agent reads exactly what `withHistory(withMemories(...))` gives it today.

### Errors

- A strategy result with `stopReason: "error"` flows to `response` and comes back as a result.
- A strategy that throws, or an abort, makes `runProductionGraph` reject. The service's
  `runWithTimeout` turns that into `thrown` or `timeout`, as today.
- The router never rejects except on abort, and `summarize` never rejects.

## `src/agents/index.ts`

```ts
/** The strategy of a route: react and plan-execute from the registry, reflect as react with reflection. */
export function createRouteStrategy(
  registry: StrategyRegistry, route: Route, dependencies: StrategyDependencies,
): ReasoningStrategy;
```
