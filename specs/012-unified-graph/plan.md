# Implementation Plan: Unified Graph

**Branch**: `012-unified-graph` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-unified-graph/spec.md`

## Summary

Every `POST /chat` request now runs through one LangGraph `StateGraph`, built per request in
`src/graph/production-graph.ts`:

```text
START -> context -> router -> { react | plan-execute | reflect } -> response -> END
```

- **context**: runs the summarization step when a batch is due (011) and composes the agent's
  input: memories, summary, recent messages, request. It emits the `summarize` event.
- **router**: when the caller forced no route, makes one `withStructuredOutput` call that returns
  `{ route, reason }`. Its prompt holds a routing table. A thrown error or an invalid answer falls
  back to `react`. It always emits exactly one `route` event with `source` set to `router`,
  `override`, or `fallback`.
- **react / plan-execute / reflect**: run the existing strategies (`reflect` is ReAct wrapped with
  `withReflection`) on the composed input. A conditional edge on `state.route.route` picks one.
- **response**: turns the strategy's result into the graph result and emits the final `answer`
  event.

Every event in the graph's trace gets a `node` field. The tagging and the routing decision are
pure functions with their own tests. Recall, the conversation reads, and the strategy-name check
stay in the service before the graph, so their errors (`422`, `404`, `500`) behave exactly as
today. The whole graph runs under the request timeout.

In the HTTP contract, `strategy` and `reflect` both become optional. `reflect: true` is an alias for
`strategy: "reflect"`, and it is a `400` together with another strategy.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer

**Primary Dependencies**: `@langchain/langgraph` ^1.6 (`StateGraph`, `Annotation`,
`addConditionalEdges`), `@langchain/core` ^1.3 (`withStructuredOutput`), `zod` ^4, Express. No new
dependency.

**Storage**: No change. The context node calls the existing `saveSummary` through the summarization
step; no new table.

**Testing**: `node:test` through `tsx`, with `ScriptedChatModel` scripting the router, strategy, and
summarizer turns; `":memory:"` stores; no network.

**Target Platform**: Node.js server (`npm run dev`) and the existing CLIs.

**Project Type**: Web service (Express API) with CLI tools.

**Performance Goals**: The router adds one model call to a request without `strategy`, and none to
a request with one (SC-005).

**Constraints**: The router never fails a request (FR-006). Domain errors raised before the run keep
their status codes. The run timeout covers the whole graph.

**Scale/Scope**: 4 new source files under `src/graph/` plus tests. Changes in `domain/types.ts`,
`http/schemas.ts`, `http/chat-service.ts`, `http/chat-reply.ts`, `trace/format.ts`, and their tests.
`docs/insomnia.json` gets its `reflect` requests updated (see [quickstart.md](quickstart.md) §4).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | The controller calls `runChat` (service). The service builds and invokes the graph. The graph (agent layer, beside `src/agents/`) calls the strategies and the model. The graph never sees the stores: the service hands it a `summarize` function. |
| II. Validated Boundaries | Pass | `ChatRequest` gets the optional `strategy`/`reflect` and a refinement for the conflict. `ChatReply`/`ErrorReply` get the `route` event and `node` on every event; the controller still parses every reply. The router's answer is validated with zod before use. |
| III. Domain Errors at the Edge | Pass | `UnknownStrategyError` is still thrown by the service and translated by the controller. The conflict is a zod issue (`400`), not a new error class. |
| IV. Pure Functions | Pass | `decideRoute`, `requestedRoute`, `routeOf`, `tagNode`, `finalizeTrace`, and `composeContext` are pure. Nodes are thin adapters around them; the model, summarization, and strategies are the only side effects. |
| V. Tested and Green | Pass | Unit tests for each pure function, a graph test with a scripted model for each route, fallback, and override, and HTTP tests for the contract. `npm run typecheck` and `npm test` gate the work. |
| Stack and Security | Pass | No new dependency, no SQL, and no secret. The router's reason is model text shown in the trace, the same as `thought`. |

**Post-design re-check (after Phase 1)**: still passes. See the notes in [research.md](research.md)
on the run-timeout change (R6) and on the removed `withSummarization` (R5).

## Project Structure

### Documentation (this feature)

```text
specs/012-unified-graph/
├── plan.md              # This file
├── research.md          # Phase 0: decisions R1–R10
├── data-model.md        # Phase 1: routes, route decision, nodes, graph state
├── quickstart.md        # Phase 1: how to validate the feature
├── contracts/
│   ├── chat-api.md          # POST /chat request, trace, and error changes
│   └── production-graph.md  # Graph module interface and node behaviour
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── domain/
│   └── types.ts                 # + Route, RouteSource, NodeName, route event, NodeTraceEvent
├── graph/                       # NEW: the production graph (agent layer)
│   ├── routing.ts               # pure: ROUTES, routeAnswerSchema, ROUTER_PROMPT, decideRoute, requestedRoute, routeOf
│   ├── routing.test.ts
│   ├── node-trace.ts            # pure: tagNode, finalizeTrace
│   ├── node-trace.test.ts
│   ├── router.ts                # createRouter: one withStructuredOutput call, never throws except on abort
│   ├── router.test.ts
│   ├── production-graph.ts      # GraphState, nodes, edges, runProductionGraph
│   └── production-graph.test.ts
├── agents/
│   ├── index.ts                 # createRouteStrategy(registry, route, deps)
│   ├── history.ts               # composeInput reused by the context node (no change)
│   └── memories.ts              # composeMemoryInput reused by the context node (no change)
├── http/
│   ├── schemas.ts               # ChatRequest optional strategy/reflect + refine; node on events; route event
│   ├── chat-service.ts          # builds and runs the graph; recall/reads stay before it
│   ├── chat-reply.ts            # RunOutcome carries node-tagged events; withSummarization removed
│   └── *.test.ts                # updated to the new trace shape
└── trace/
    └── format.ts                # formats the route event; prefixes the node when present
```

**Structure Decision**: Single project. The graph lives in a new `src/graph/` folder, as in
`docs/code-examples/spec12-example.ts`, at the same layer as `src/agents/`. Node names are in
English (R1).

## Complexity Tracking

No constitution violations to justify.
