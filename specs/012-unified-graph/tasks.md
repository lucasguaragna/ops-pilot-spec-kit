---

description: "Task list for the unified production graph"
---

# Tasks: Unified Graph

**Input**: Design documents from `specs/012-unified-graph/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/chat-api.md](contracts/chat-api.md),
[contracts/production-graph.md](contracts/production-graph.md), [quickstart.md](quickstart.md)

**Tests**: Included. FR-014 asks for tests of the pure routing decision and an end-to-end graph test
with a scripted model, and the constitution requires a test for all new logic (principle V). Tests
use `node:test` through `tsx`, `ScriptedChatModel` (`textTurn`, `toolCallTurn`, `withUsage`),
`":memory:"` stores, and no network.

**Organization**: Tasks are grouped by user story, so each story can be implemented and tested on
its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1, US2, US3)
- Every task names its exact file path

## Path Conventions

Single project: `src/` at the repository root, with tests next to their source as `*.test.ts`.

---

## Phase 1: Setup

**Purpose**: Confirm a green baseline before changing anything.

- [X] T001 Run `npm run typecheck` and `npm test` from the repository root on the current code and
  record the passing test count, so later regressions are easy to spot (no file changes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared types, constants, and the route-to-strategy mapping that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 In `src/domain/types.ts`, add `type Route = "react" | "plan-execute" | "reflect"`,
  `type RouteSource = "router" | "override" | "fallback"`,
  `interface RouteDecision { route: Route; reason: string; source: RouteSource }`,
  `type NodeName = "context" | "router" | Route | "response"`, and
  `type NodeTraceEvent = TraceEvent & { node: NodeName }`. Add the member
  `{ type: "route"; route: Route; reason: string; source: RouteSource }` to the `TraceEvent` union.
  Make `RunResult` generic as `RunResult<E = TraceEvent>`, with `trace: E[]`, so every existing use
  of `RunResult` keeps compiling unchanged
- [X] T003 Move the `SummarizationStep` type from `src/http/chat-reply.ts` to
  `src/agents/history-summarizer.ts`, so the graph (agent layer) does not import from `src/http/`.
  Re-export it from `src/http/chat-reply.ts` so `summaryLogLine` and the existing imports in
  `src/http/chat-service.ts` keep working
- [X] T004 Create `src/graph/routing.ts` with the constants only:
  `export const ROUTES = ["react", "plan-execute", "reflect"] as const satisfies readonly Route[]`,
  `export const NODE_NAMES = ["context", "router", ...ROUTES, "response"] as const satisfies readonly NodeName[]`,
  `export const routeAnswerSchema = z.object({ route: z.enum(ROUTES), reason: z.string() })`,
  `export const OVERRIDE_REASON = "Requested by the caller"`, and
  `export const FALLBACK_ROUTE: Route = "react"` (depends on T002)
- [X] T005 [P] In `src/trace/format.ts`, format the new `route` event in `formatEvent` as one line
  holding the route, the source, and the reason (for example
  `route: plan-execute (router) Several alerts, one action each`), and add a case for it in
  `src/trace/format.test.ts` (depends on T002)
- [X] T006 [P] In `src/http/schemas.ts`, add the `route` member to `TraceEventSchema`:
  `{ type: z.literal("route"), route: z.enum(ROUTES), reason: z.string(), source: z.enum(["router", "override", "fallback"]) }`.
  Add a parse case for it in `src/http/schemas.test.ts` (depends on T004)
- [X] T007 [P] In `src/agents/index.ts`, add
  `createRouteStrategy(registry: StrategyRegistry, route: Route, dependencies: StrategyDependencies): ReasoningStrategy`:
  `react` and `plan-execute` map to `createStrategy(registry, route, dependencies, { reflect: false })`,
  and `reflect` maps to `createStrategy(registry, "react", dependencies, { reflect: true })`. Do not
  add `reflect` to `strategyFactories` (research R7). Test the three routes in
  `src/agents/index.test.ts`: the strategy names are `react`, `plan-execute`, and `reflect:react`
  (depends on T002)
- [X] T008 Run `npm run typecheck` and `npm test`; both must be green before any story starts

**Checkpoint**: Types, constants, the route event's format and schema, and the route-to-strategy
mapping exist. Nothing calls them yet.

---

## Phase 3: User Story 1 - The agent picks the right strategy on its own (Priority: P1) 🎯 MVP

**Goal**: Every `POST /chat` request runs through
`START -> context -> router -> { react | plan-execute | reflect } -> response -> END`. A request with
only `message` gets a route chosen by the router, shown as one `route` event, and the chosen
strategy's answer.

**Independent Test**: With a scripted fake model, send one request without `strategy` where the
router answers `plan-execute`. The trace holds a `route` event with `route: "plan-execute"`,
`source: "router"`, and the scripted reason, followed by a `plan` event, and the reply is the
plan-and-execute answer. `metrics.llmCalls` counts the router call.

### Tests for User Story 1

> Write these tests first and check that they fail before the matching implementation.

- [X] T009 [P] [US1] Create `src/graph/routing.test.ts`:
  - `decideRoute({ kind: "override", route })` returns `source: "override"` and
    `reason: "Requested by the caller"`.
  - `decideRoute({ kind: "answered", parsed })` with a valid answer returns `source: "router"` and
    the reason trimmed. An empty or whitespace-only reason becomes `"No reason given"`. A long reason
    is kept as it is.
  - `parsed: null`, a route outside `ROUTES`, or a missing `reason` returns
    `{ route: "react", source: "fallback", reason: "Router failed: invalid answer" }`.
  - `decideRoute({ kind: "thrown", error: new TypeError("secret provider text") })` returns
    `reason: "Router failed: TypeError"`. The error's message never appears in the reason.
  - `routeOf({ decision })` returns `decision.route`.
  - `requestedRoute`: `{}` gives `undefined`. `{ strategy: "plan-execute" }` gives `"plan-execute"`.
    `{ reflect: true }` and `{ strategy: "reflect", reflect: true }` give `"reflect"`.
    `{ strategy: "nope" }` throws `UnknownStrategyError` whose known strategies are exactly
    `["react", "plan-execute", "reflect"]`.
  - `ROUTER_PROMPT` contains every value of `ROUTES` and the rule `when unsure, choose react`.
- [X] T010 [P] [US1] Create `src/graph/router.test.ts` with `ScriptedChatModel`. Each case checks
  the returned `llmCalls` and `promptTokens`:
  - A `toolCallTurn` named `route` with `{ route: "plan-execute", reason: "…" }` and `withUsage`
    gives a `router` decision, `llmCalls: 1`, and the scripted prompt tokens.
  - A `textTurn` (so `parsed: null`) gives a fallback.
  - A tool call with `route: "nope"` gives a fallback.
  - A model that throws gives a fallback with the error's class name.
  - An already-aborted `signal` makes `route()` reject instead of falling back.
- [X] T011 [P] [US1] Create `src/graph/production-graph.test.ts`. It calls `runProductionGraph`
  with a fake `Router` that returns a fixed decision and records its calls, and with
  `strategyFor` building the real strategies on a `ScriptedChatModel`:
  - One case per route: `react` answers; `plan-execute` puts a `plan` event after the `route` event;
    `reflect` puts at least one `critique` event after the `route` event.
  - An override (`override: "plan-execute"`) makes zero router calls and emits a `route` event with
    `source: "override"`.
  - A fallback decision runs `react`.
  - A `summarize` stub returning a `stored` step puts the `summarize` event first. The composed
    input then holds the stored summary and `verbatim`. With `not_due`, it holds `previousSummary`
    and `fallbackHistory`.
  - `metrics.llmCalls` and `promptTokens` are the sum of the summarizer, router, and strategy.
  - A strategy that returns `stopReason: "error"` resolves with that result.
  - A strategy that throws makes `runProductionGraph` reject.
  - SC-003: a table of 6 requests (2 per route) with fake strategies from `strategyFor` checks that
    the decided route's strategy is the one that ran, every time.

### Implementation for User Story 1

- [X] T012 [US1] In `src/graph/routing.ts`, add the pure functions from
  [contracts/production-graph.md](contracts/production-graph.md):
  - `requestedRoute({ strategy, reflect })` returns `"reflect"` when `reflect` is true, the
    `strategy` when it is in `ROUTES`, `undefined` when neither is set, and otherwise throws
    `new UnknownStrategyError(strategy, [...ROUTES])`.
  - `decideRoute(outcome)` follows the rules in [data-model.md](data-model.md) (RouteDecision):
    `"No reason given"` for an empty reason, `"Router failed: invalid answer"` when
    `routeAnswerSchema.safeParse` fails, and `"Router failed: <error class name>"` for a thrown
    error.
  - `routeOf(state)` returns `state.decision.route`, and throws a plain `Error` if `decision` is
    missing, which is a programming error.
  - Export `ROUTER_PROMPT`. It holds the system instructions and the Markdown routing table from
    research R3, with the columns Route, Use it when, and Example, and it ends with
    `When unsure, choose react.` Leave the table rows as the single `TODO(human)` contribution (see
    Notes)
- [X] T013 [US1] Create `src/graph/router.ts` with `interface Router` and
  `createRouter({ model })`:
  - `route(input, { signal })` builds
    `model.withStructuredOutput(routeAnswerSchema, { name: "route", method: "functionCalling", includeRaw: true })`
    and invokes it once with `[new SystemMessage(ROUTER_PROMPT), new HumanMessage(input)]`, passing
    `{ signal, callbacks: [counter] }` with a fresh `LlmCallCounter`.
  - It maps the result through `decideRoute({ kind: "answered", parsed })`.
  - In `catch`, it rethrows when `signal?.aborted`, and otherwise returns
    `decideRoute({ kind: "thrown", error })`.
  - It returns `{ decision, llmCalls: counter.count, promptTokens: counter.promptTokens }`.
  - Follow the existing pattern in `src/agents/structured-output.ts` and
    `src/agents/plan-and-execute.ts`
- [X] T014 [US1] Create `src/graph/production-graph.ts`.
  - `GraphState = Annotation.Root({...})` has the channels of the GraphState table in
    [data-model.md](data-model.md). For this story `trace` is `TraceEvent[]` with a concat reducer.
    `llmCalls` uses a sum reducer with default 0. `promptTokens` uses `addPromptTokens` with default
    `null`. Every other channel keeps the last value.
  - Export `ProductionGraphDependencies`, `ProductionGraphInput`, `ProductionGraphResult`, and
    `runProductionGraph(dependencies, input, { signal })`, as in
    [contracts/production-graph.md](contracts/production-graph.md).
  - The `context` node awaits `summarize()`.
    - `history`: `stored ? input.verbatim : input.fallbackHistory`.
    - `summaryText`: `stored ? step.rendered : input.previousSummary`.
    - `input`: `composeMemoryInput(recalled, composeInput(history, message, summaryText))`.
    - When the step is `stored`, it emits `{ type: "summarize", content: step.rendered, absorbed: step.absorbed }`.
    - When the step is not `not_due`, it adds the step's `llmCalls` and `promptTokens`.
  - The `router` node calls `decideRoute({ kind: "override", route })` when `override` is set, with
    no model call. Otherwise it calls `router.route(state.input, { signal })` and adds its counts.
    Either way it emits `{ type: "route", ...decision }`.
  - Each strategy node runs
    `strategyFor(route).run(state.input, { maxIterations, signal: config.signal })`, writes
    `strategyResult`, and appends the strategy's trace and metrics.
  - The `response` node builds `result` from `strategyResult`, with the summed `trace`, `llmCalls`,
    and `promptTokens`.
  - Edges: `START -> context -> router`, then
    `addConditionalEdges("router", routeOf, { react: "react", "plan-execute": "plan-execute", reflect: "reflect" })`,
    then each strategy node `-> response -> END`.
  - `latencyMs` is measured around the whole `invoke`. Build the graph per call, so there is no
    module state
- [X] T015 [US1] In `src/http/schemas.ts`, make `ChatRequest.strategy` `z.string().optional()`
  with no default, and `ChatRequest.reflect` `z.boolean().optional().default(false)`. Update
  `src/http/schemas.test.ts`: `{ message }` alone parses, with `strategy` undefined and `reflect`
  false
- [X] T016 [US1] Rewrite the run part of `runChat` in `src/http/chat-service.ts`. Keep the order of
  research R6:
  1. `const override = requestedRoute(request)`, before any read, so it is still the first throw.
  2. The `summaryOf` and `messagesAfter` reads, then recall, then `planHistory`.
  3. `const conversationId = request.conversationId ?? conversations.create().id`.
  4. `runWithTimeout((signal) => runProductionGraph(deps, input, { signal }), settings.timeoutMs)`.
     It maps `done`, `thrown`, and `timeout` to `RunOutcome` exactly as `runTimed` does now.

  The graph's inputs:
  - `summarize` is a closure over the existing `summarize(...)`. It returns `{ kind: "not_due" }`
    when no batch is due, and it writes `summaryLogLine` itself, so the log still appears when the
    graph later times out.
  - `strategyFor` is memoized per route over
    `createRouteStrategy(settings.registry, route, { ...dependencies, tools })`.
  - The router is `settings.createRouter?.(dependencies.model) ?? createRouter({ model: dependencies.model })`.
  - `fallbackHistory` is `plan.toSummarize.length > 0 ? uncovered.slice(-MAX_VERBATIM) : plan.verbatim`.
  - `previousSummary` is the rendered previous summary or `""`.

  After the run:
  - Take `history` and `summaryText` from the graph result. On `thrown` or `timeout`, use
    `fallbackHistory` and `previousSummary`.
  - The breakdown's `system` is `strategyFor(decision.route).systemPrompt`, and `react`'s after a
    thrown run or a timeout.
  - Remove the `createStrategy`, `withHistory`, `withMemories`, and `withSummarization` calls, and
    delete `runTimed` if nothing else uses it. Update the JSDoc of `runChat`
- [X] T017 [US1] In `src/http/chat-reply.ts`, delete `withSummarization`. In
  `src/http/chat-reply.test.ts`, delete its tests, because T011 now covers the `summarize` event and
  the summed counts
- [X] T018 [US1] Add the optional setting `createRouter?: (model: BaseChatModel) => Router` to the
  resolved settings in `src/http/server.ts`. In `src/testing/test-server.ts`, accept a `router`
  option, defaulting to a fake that returns `{ route: "react", source: "router", reason: "test" }`
  and records its calls, and make sure the fake registry is keyed `react` and `plan-execute`
- [X] T019 [US1] Update `src/http/chat-service.test.ts` and `src/http/server.test.ts`:
  - A `{ message }` request goes through the router. A router fake choosing `plan-execute` gives a
    `route` event with `source: "router"`, then the plan-and-execute events and answer.
  - `metrics.llmCalls` includes the router's call.
  - The stored-summarization tests now expect the `summarize` event first and the `route` event
    after it.
  - Adjust the existing trace assertions to the extra `route` event. Do not change strategy logic
- [X] T020 [US1] Run `npm run typecheck` and `npm test`; both green

**Checkpoint**: `POST /chat` with only `message` works end to end. The router chooses, falls back
to `react` on failure, and the trace shows one `route` event. This is the MVP.

---

## Phase 4: User Story 2 - Every trace event says which step produced it (Priority: P2)

**Goal**: Every event in a `POST /chat` trace carries `node`. The final answer belongs to
`response`, and rejected `reflect` drafts stay with `reflect`. The CLI formatter shows the node
when there is one.

**Independent Test**: Run one request through the graph with a scripted model. Every event has
`node`, the values follow graph order (`context`, `router`, the strategy, `response`), and the
strategy's events carry the chosen route.

### Tests for User Story 2

- [X] T021 [P] [US2] Create `src/graph/node-trace.test.ts`:
  - `tagNode` adds `node` to each event and does not mutate its input.
  - `finalizeTrace("react", completedResult)` tags every event `react` except the last `answer`,
    which gets `response`.
  - `finalizeTrace("reflect", …)` on a run with a rejected draft keeps the earlier `answer` with
    `node: "reflect"`, and only the last one gets `response`.
  - Results with `stopReason: "max_iterations"` and with `stopReason: "error"` are tagged with the
    route, and no event gets `response`.
- [X] T022 [P] [US2] In `src/trace/format.test.ts`, check that an event with `node` prints the node
  first (for example `[plan-execute] action: list_alerts …`), and that an event without `node`
  prints exactly as today (arena and bench)

### Implementation for User Story 2

- [X] T023 [US2] Create `src/graph/node-trace.ts` with the pure
  `tagNode(events, node): NodeTraceEvent[]` and `finalizeTrace(route, result): NodeTraceEvent[]`,
  as in [contracts/production-graph.md](contracts/production-graph.md) and research R5
- [X] T024 [US2] In `src/graph/production-graph.ts`, change the `trace` channel to
  `NodeTraceEvent[]`:
  - The `context` node tags `summarize` with `"context"`.
  - The `router` node tags `route` with `"router"`.
  - Each strategy node appends `finalizeTrace(route, result)`.
  - `result` is `RunResult<NodeTraceEvent>`.

  In `src/graph/production-graph.test.ts`, add the checks: every event has `node`, the values come
  in graph order, a `reflect` run's drafts keep `node: "reflect"`, and a run that hit the iteration
  limit has no `response` event
- [X] T025 [US2] In `src/http/chat-reply.ts`, make `RunOutcome`'s `result` a
  `RunResult<NodeTraceEvent>`. In `src/http/schemas.ts`, add the required `node: z.enum(NODE_NAMES)`
  to every member of `TraceEventSchema`. Update `src/http/schemas.test.ts`: an event without `node`
  fails to parse
- [X] T026 [US2] In `src/trace/format.ts`, make `formatEvent` accept
  `TraceEvent & { node?: NodeName }` and prefix `[<node>] ` only when `node` is present
- [X] T027 [US2] In `src/http/server.test.ts`, check that every event in a `200` reply and in a
  `502 run_failed` reply that has a trace carries a `node` from `NODE_NAMES`, and that `summarize`
  has `node: "context"` (FR-009, SC-001)
- [X] T028 [US2] Run `npm run typecheck` and `npm test`; both green

**Checkpoint**: The trace shows the path through the graph, and the arena and bench output is
unchanged.

---

## Phase 5: User Story 3 - The caller can still force a strategy (Priority: P3)

**Goal**: Sending `strategy` (or `reflect: true`) forces that route with no router call. The `route`
event says `source: "override"`, an unknown name is still a `422`, and a contradictory body is a
`400`.

**Independent Test**: Send `{ message, strategy: "react" }` with a router fake that records its
calls. ReAct runs, the `route` event has `route: "react"` and `source: "override"`, and the router
was never called.

### Tests for User Story 3

- [X] T029 [P] [US3] In `src/http/schemas.test.ts`, cover the body table in
  [contracts/chat-api.md](contracts/chat-api.md). `{ strategy: "react", reflect: true }` and
  `{ strategy: "plan-execute", reflect: true }` fail with one issue at path `["reflect"]` and the
  message `reflect: true only combines with strategy "reflect"`. `{ strategy: "reflect", reflect: true }`,
  `{ reflect: true }`, and `{ strategy: "react", reflect: false }` parse
- [X] T030 [P] [US3] In `src/http/server.test.ts`, check the following:
  - `{ message, strategy: "plan-execute" }` gives `source: "override"` and
    `reason: "Requested by the caller"`. The router fake records zero calls, and `metrics.llmCalls`
    equals the strategy's own count (SC-005).
  - `{ message, reflect: true }` gives `route: "reflect"` and `source: "override"`.
  - `{ message, strategy: "react", reflect: true }` gives `400 invalid_body`.
  - `{ message, strategy: "nope" }` gives `422 unknown_strategy` with
    `knownStrategies: ["react", "plan-execute", "reflect"]`, and creates no conversation.

### Implementation for User Story 3

- [X] T031 [US3] In `src/http/schemas.ts`, add `.superRefine` to `ChatRequest`. When
  `reflect === true` and `strategy !== undefined && strategy !== "reflect"`, add an issue with
  `path: ["reflect"]` and `message: 'reflect: true only combines with strategy "reflect"'`
- [X] T032 [US3] Check that `src/http/chat-controller.ts` translates the `UnknownStrategyError`
  thrown by `requestedRoute` into `422` with the error's known list. No change is expected; fix it
  only if T030 fails
- [X] T033 [US3] Update `docs/insomnia.json`:
  - "react + reflection" and "plan-execute + reflection" become `{ message, reflect: true }`. Rename
    the second one, because it no longer runs plan-and-execute.
  - "400 - missing reflect" becomes a `400` for the conflict `strategy: "react", reflect: true`.
  - Add a request with only `message` that shows the router.
- [X] T034 [US3] Confirm that `scripts/long-conversation.sh` (which sends `strategy: "react",
  reflect: false`) and `src/long-conversation.test.ts` still pass. They now run as an override, and
  no change is expected
- [X] T035 [US3] Run `npm run typecheck` and `npm test`; both green

**Checkpoint**: Today's callers keep working, overrides are reproducible and cost no extra call, and
the alias and conflict rules hold.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T036 [P] Confirm that `src/arena.ts`, `src/bench.ts`, `src/arena.test.ts`, and
  `src/bench.test.ts` need no change: they build strategies by name, outside the graph, and their
  events print with no node
- [X] T037 [P] Search the repository docs (`README.md`, `docs/`, except `docs/prompts/`) for
  `POST /chat` body examples that make `strategy` or `reflect` look required, and update them to the
  new contract
- [X] T038 Review the JSDoc in `src/graph/*.ts` and `src/http/chat-service.ts`. It should state that
  the request timeout now also covers summarization (research R6), and that the router never fails
  a request
- [X] T039 Run `npm run typecheck` and `npm test` one last time and compare the test count with
  T001
- [ ] T040 Manual validation (needs a key in `.env`, which only the app reads): the user runs the
  [quickstart.md](quickstart.md) scenarios §2 and §3 with `npm run dev`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. Blocks every story.
- **US1 (Phase 3)**: after Foundational. It builds the graph and the service wiring.
- **US2 (Phase 4)**: after US1, because it tags the graph's trace.
- **US3 (Phase 5)**: after US1, because the override path runs through the graph and the service.
  It does not need US2, so US2 and US3 can be done in either order.
- **Polish (Phase 6)**: after the stories you ship.

### Within Each User Story

- Write the tests first and check that they fail.
- Pure functions come before the router, the router before the graph, the graph before the service,
  and the service before the HTTP tests.
- End each story with `npm run typecheck` and `npm test`.

### Task-Level Dependencies

- T004 needs T002. T005 and T007 need T002. T006 needs T004.
- T012 needs T004. T013 needs T012. T014 needs T012, T013, T003, and T007.
- T016 needs T014, T015, and T018. T017 needs T016. T019 needs T016 through T018.
- T023 is required by T024. T025 needs T024. T026 is independent of T024 and T025.
- T031 is independent of US2. T033 and T034 need T031.

### Parallel Opportunities

- Phase 2: T005, T006, and T007 touch different files once T002 and T004 are done.
- US1 tests: T009, T010, and T011 are three new files.
- US2 tests: T021 and T022 are different files.
- US3 tests: T029 and T030 are different files.
- After US1, US2 and US3 can go in parallel. The only shared files are `src/http/schemas.ts` and
  `src/http/server.test.ts`, so merge those edits with care.
- Polish: T036 and T037.

---

## Parallel Example: User Story 1

```text
# The three test files of US1, together:
Task: "Create src/graph/routing.test.ts (decideRoute, routeOf, requestedRoute, ROUTER_PROMPT)"
Task: "Create src/graph/router.test.ts (valid, parsed null, invalid route, thrown, aborted)"
Task: "Create src/graph/production-graph.test.ts (one per route, override, fallback, summarize, errors)"
```

## Parallel Example: User Story 2

```text
Task: "Create src/graph/node-trace.test.ts (tagNode, finalizeTrace)"
Task: "Add node-prefix cases to src/trace/format.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001) and Phase 2 (T002–T008).
2. Phase 3 (T009–T020): the graph, the router, and the service wiring.
3. **Stop and validate**: a `{ message }` request gets a router choice, a `route` event, and the
   chosen strategy's answer. Everything stays green.

### Incremental Delivery

1. MVP (US1): the router chooses.
2. US2: `node` on every event, which makes the path readable in class and in the CLI.
3. US3: the override rules are complete, with the `400` conflict, the `422` list, and the updated
   Insomnia collection.
4. Polish.

Each story ends green and adds value without breaking the earlier ones.

---

## Notes

- Learning mode: the single `TODO(human)` contribution is the routing table rows of `ROUTER_PROMPT`
  in `src/graph/routing.ts` (T012). This is the business rule that decides which strategy each kind
  of request gets. Everything around it (the schema, `decideRoute`, the fallback) is ready before
  the request, and the `ROUTER_PROMPT` test in T009 stays red until the rows are in.
- The strategies (`src/agents/react.ts`, `src/agents/plan-and-execute.ts`,
  `src/agents/reflection.ts`) do not change. Only the graph knows about nodes (research R4).
- Do not read `.env`. The manual scenarios in T040 are for the user to run.
- Commit only when the user asks.
