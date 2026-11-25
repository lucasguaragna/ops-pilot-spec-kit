# Data Model: Unified Graph

No persisted data changes. Every entity below lives in memory, for one request.

## Route

`type Route = "react" | "plan-execute" | "reflect"`, from `ROUTES` (a `const` tuple, in this
order). It names the strategy that runs and also the strategy node.

| Route | Strategy built |
| --- | --- |
| `react` | `createStrategy(registry, "react", deps, { reflect: false })` |
| `plan-execute` | `createStrategy(registry, "plan-execute", deps, { reflect: false })` |
| `reflect` | `createStrategy(registry, "react", deps, { reflect: true })` |

## RouteSource

`type RouteSource = "router" | "override" | "fallback"`

| Source | When |
| --- | --- |
| `router` | The router returned a valid `{ route, reason }` |
| `override` | The request had `strategy` or `reflect: true`; no router call was made |
| `fallback` | The router threw (not an abort), returned `parsed: null`, or returned an invalid answer |

## RouteDecision

`{ route: Route; reason: string; source: RouteSource }`

Validation and rules (`decideRoute`, pure):

- `source: "router"`: `reason` is the router's text, trimmed. If that leaves it empty, it becomes
  `"No reason given"`.
- `source: "override"`: `reason` is the fixed `"Requested by the caller"`.
- `source: "fallback"`: `route` is always `react`, and `reason` is `"Router failed: <cause>"`. The
  cause is `invalid answer` or the error's class name, never the provider's error text.

## Route answer (router output)

`routeAnswerSchema = z.object({ route: z.enum(ROUTES), reason: z.string() })`, used as the
structured-output tool `route`. Anything that fails it is a fallback.

## NodeName

`type NodeName = "context" | "router" | Route | "response"`. The graph's node ids are exactly
these values.

## Trace events

The domain `TraceEvent` union gains one member:

`{ type: "route"; route: Route; reason: string; source: RouteSource }`

`NodeTraceEvent = TraceEvent & { node: NodeName }` is what the graph returns and what `POST /chat`
sends. Which node owns which event:

| Event | Node |
| --- | --- |
| `summarize` | `context` |
| `route` | `router` |
| `thought`, `action`, `observation`, `plan`, `critique` | the chosen route |
| `answer` that is not the final one (a `reflect` draft that was rejected) | the chosen route |
| final `answer` of a completed run | `response` |

Order: `context` events, then the single `route` event, then the strategy's events, then the final
`answer`. That is, the order of the nodes.

## GraphState (LangGraph `Annotation.Root`)

| Channel | Type | Reducer | Written by |
| --- | --- | --- | --- |
| `message` | `string` | last value | input |
| `input` | `string` | last value | `context` (the composed input) |
| `history` | `NewMessage[]` | last value | `context` (the messages given word for word) |
| `summaryText` | `string` | last value | `context` |
| `override` | `Route \| undefined` | last value | input |
| `decision` | `RouteDecision \| undefined` | last value | `router` |
| `strategyResult` | `RunResult \| undefined` | last value | strategy node |
| `result` | `RunResult<NodeTraceEvent> \| undefined` | last value | `response` |
| `trace` | `NodeTraceEvent[]` | concat | `context`, `router`, strategy node |
| `llmCalls` | `number` | sum, default 0 | `context`, `router`, strategy node |
| `promptTokens` | `number \| null` | `addPromptTokens`, default `null` | `context`, `router`, strategy node |

The edge after `router` is `addConditionalEdges("router", routeOf, { react: "react",
"plan-execute": "plan-execute", reflect: "reflect" })`, where `routeOf(state)` is
`state.decision.route`.

## Graph result

`ProductionGraphResult = { result: RunResult<NodeTraceEvent>; decision: RouteDecision; history:
NewMessage[]; summaryText: string; step: SummarizationStep }`.

`RunResult` becomes generic over its event type (`RunResult<E = TraceEvent>`), so strategies keep
`RunResult` and the graph returns `RunResult<NodeTraceEvent>`. `metrics.llmCalls` and
`metrics.promptTokens` are the state's sums. `latencyMs` is measured around the whole graph run.

## Request fields (`ChatRequest`)

| Field | Before | After |
| --- | --- | --- |
| `strategy` | `string`, default `"react"` | `string`, optional; absent means the router decides |
| `reflect` | `boolean`, required | `boolean`, optional, default `false`; `true` means `strategy: "reflect"` |
| refinement | none | `reflect: true` with a `strategy` other than `"reflect"` is an issue at `["reflect"]` (400) |
