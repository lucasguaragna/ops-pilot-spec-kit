# Feature Specification: Unified Graph

**Feature Branch**: `012-unified-graph`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "Unified graph: production-graph.ts with the nodes context, router,
the 3 strategies as nodes, and response. Router: withStructuredOutput (route, reason); a table in
the prompt; a `route` event and a `node` field on every trace event. /chat: `strategy` becomes
optional (when it is sent, it is an override in the trace)." The original Portuguese text is in
`docs/prompts/0152-20261125-134526.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent picks the right strategy on its own (Priority: P1)

An on-call engineer sends a message to `POST /chat` without saying how the agent should reason.
Today the caller must know the strategy names and pick one (`react` by default), so a multi-step
request ("check every firing alert, open an incident for each critical one, then summarize")
runs with the strategy that suits a quick lookup. With this feature one production graph handles
every request: it builds the context, a router reads the request and chooses one of the three
strategies (`react`, `plan-execute`, `reflect`), the chosen strategy runs, and a response step
produces the reply. The router says which strategy it chose and why, and both show up in the
trace.

**Why this priority**: This is the value of the feature. The caller no longer needs to know the
strategies, and each request gets the strategy that fits it.

**Independent Test**: With a scripted fake model, send one request without `strategy` where the
router answers `plan-execute`, and check that the trace holds a `route` event with
`route: "plan-execute"` and the scripted reason, followed by the plan-and-execute events, and that
the reply is the plan-and-execute answer.

**Acceptance Scenarios**:

1. **Given** a request without `strategy`, **When** the router chooses `react`, **Then** the
   strategy that runs is ReAct and the trace holds one `route` event with `route: "react"` and the
   router's reason, before any event of the strategy.
2. **Given** a request without `strategy`, **When** the router chooses `plan-execute`, **Then** the
   trace holds a `plan` event after the `route` event, and the reply is the plan-and-execute answer.
3. **Given** a request without `strategy`, **When** the router chooses `reflect`, **Then** the
   trace holds at least one `critique` event after the `route` event.
4. **Given** any request, **When** the reply is built, **Then** `metrics.llmCalls` counts the
   router's model call together with the strategy's calls.

---

### User Story 2 - Every trace event says which step produced it (Priority: P2)

When the engineer (or the instructor in class) reads a trace, they want to see the path the
request took through the graph. Every trace event carries a `node` field naming the step that
produced it: `context`, `router`, `react`, `plan-execute`, `reflect`, or `response`. Reading the
`node` fields in order shows the path, for example `context -> router -> plan-execute -> response`.

**Why this priority**: The graph is only useful to learn from and to debug if the trace shows which
step did what. It depends on User Story 1 for the graph to exist.

**Independent Test**: Run one request through the graph with a scripted fake model and check that
every event of the reply's trace has a `node` field, that the values appear in graph order, and
that the strategy events carry the node of the chosen strategy.

**Acceptance Scenarios**:

1. **Given** any reply with a trace, **When** it is read, **Then** every event has a `node` field
   whose value is one of the six node names.
2. **Given** a request whose history is summarized, **When** the trace is read, **Then** the
   `summarize` event has `node: "context"` and comes before the `route` event.
3. **Given** a completed run, **When** the trace is read, **Then** the `route` event has
   `node: "router"`, the strategy's `thought`, `action`, `observation`, `plan`, and `critique`
   events have the chosen strategy's node, and the final `answer` event has `node: "response"`.
4. **Given** the trace formatter used by the CLI tools, **When** it prints an event that carries a
   `node`, **Then** the printed line shows the node. The arena and the bench run strategies
   directly, outside the graph, so their events carry no node and print as today.

---

### User Story 3 - The caller can still force a strategy (Priority: P3)

The arena, the bench, the course exercises, and some callers need to run a given strategy on
purpose, to compare strategies or reproduce a run. `strategy` stays in the `POST /chat` body, but
it is now optional. When it is sent, the router does not choose: the requested strategy runs, and
the `route` event records that the route was an override requested by the caller, not a choice of
the router.

**Why this priority**: It keeps today's callers and tools working and keeps runs reproducible, but
the main path is the router's choice.

**Independent Test**: Send a request with `strategy: "react"` and a scripted fake model that has no
router answer, and check that ReAct runs, that the `route` event says `route: "react"` and marks it
as an override, and that no router model call was made.

**Acceptance Scenarios**:

1. **Given** a request with `strategy: "plan-execute"`, **When** it runs, **Then** plan-and-execute
   runs, the `route` event has `route: "plan-execute"` and `source: "override"`, and `metrics.llmCalls`
   holds no router call.
2. **Given** a request with an unknown `strategy`, **When** it is sent, **Then** the reply is the
   same `422 unknown_strategy` as today, listing the known strategies, and nothing is read or
   written.
3. **Given** a request without `strategy`, **When** the router chooses, **Then** the `route` event
   has `source: "router"`.

---

### Edge Cases

- The router's model call fails, times out, or returns a route that is not one of the three: the
  request does not fail. The graph falls back to `react`, and the `route` event says the route is
  the fallback and why (for example "router failed: invalid route").
- The router's reason is empty or very long: an empty reason is replaced by a fixed text; a long
  reason is kept as returned (it is the model's explanation and is shown, not parsed).
- The run times out while the router is still deciding: the reply is the same `timeout` error as
  today; the router runs under the same request timeout as the strategy.
- The chosen strategy stops at the iteration limit or fails: the reply has the same stop reason or
  `run_failed` error as today, and the partial trace still carries the `route` event and the `node`
  field on every event.
- `reflect: true` is sent: it is an alias for `strategy: "reflect"`, so the `reflect` route runs as
  an override, and no router call is made. Sent with `strategy: "reflect"` it is the same request.
  Sent with `strategy: "react"` or `strategy: "plan-execute"` it is a `400 invalid_body`, because the
  combination "that strategy plus critique" no longer exists.
- A request with a `userId` and history: the context step still gives the agent the user's facts,
  then the summary, then the recent messages, then the request, exactly as today, whichever
  strategy runs.

## Clarifications

### Session 2026-11-25

- Q: How does the existing `reflect` flag relate to the new reflection route? -> A: The route is
  named `reflect`. The flag stays, now optional, only as an alias: `reflect: true` forces the
  `reflect` route as an override. Combined with another strategy it is a 400.
- Q: How is the route's origin shown? -> A: The `route` event has a `source` field (`router`,
  `override`, or `fallback`) instead of an `override` boolean, so the fallback is visible too.
- Q: Do the arena and the bench go through the graph? -> A: No. They keep running strategies by
  name, so their events have no node; the formatter shows the node only when an event has one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST run every `POST /chat` request through one production graph with the
  nodes `context`, `router`, `react`, `plan-execute`, `reflect`, and `response`, in that order:
  `context`, then `router`, then exactly one strategy node, then `response`.
- **FR-002**: The `context` node MUST build the agent's starting context the same way the chat
  service does today: recalled facts, the conversation summary (summarizing when a batch is due),
  the recent messages, and the request.
- **FR-003**: The `router` node MUST choose one route among `react`, `plan-execute`, and
  `reflect` with a single model call that returns a structured answer holding a `route` and a
  `reason`. The answer MUST be validated; anything that is not one of the three routes is treated
  as a router failure.
- **FR-004**: The router's instructions MUST hold a table that lists each route with the kind of
  request it suits, so the choice can be read and changed in one place.
- **FR-005**: The router MUST emit one `route` trace event per request holding the route, the
  reason, and its `source`: `router` (the router chose), `override` (the caller chose), or
  `fallback` (the router failed).
- **FR-006**: When the router fails (thrown error, invalid answer), the graph MUST fall back to
  `react`, emit the `route` event as a fallback with the failure in the reason, and continue. A
  router failure MUST NOT fail the request.
- **FR-007**: Each strategy node MUST run the existing strategy of that name (ReAct,
  plan-and-execute, and ReAct with critique for `reflect`) with the same tools, memory tools, limits, and
  abort signal as today.
- **FR-008**: The `response` node MUST produce the final `answer` trace event and the reply's
  answer and stop reason from the strategy's result.
- **FR-009**: Every trace event in `POST /chat` replies, including `run_failed` replies, MUST
  carry a `node` field naming the node that produced it. The trace formatter MUST show the node
  when an event carries one.
- **FR-010**: `strategy` in the `POST /chat` body MUST become optional. When it is present, the
  router node MUST make no model call, the named strategy MUST run, and the `route` event MUST be
  marked as an override with a fixed reason. An unknown name MUST still return `422
  unknown_strategy` before anything is read or written.
- **FR-010a**: `reflect` in the `POST /chat` body MUST become optional (default `false`). `reflect:
  true` MUST behave exactly like `strategy: "reflect"` (an override of the `reflect` route).
  `reflect: true` together with a `strategy` other than `reflect` MUST be rejected with `400
  invalid_body`.
- **FR-011**: `metrics.llmCalls` and `metrics.promptTokens` MUST include the router's model call
  when one was made.
- **FR-012**: The run timeout MUST cover the router and the strategy together; a timeout during
  either returns today's `timeout` error.
- **FR-013**: The reply and trace schemas MUST be validated at the HTTP boundary with the new
  `route` event and the `node` field.
- **FR-014**: The routing decision (given a router answer or an override, which route runs and
  what the `route` event says) MUST be a pure function with its own tests, and the graph MUST be
  tested end to end with a scripted fake model, with no network.

### Key Entities

- **Route**: one of `react`, `plan-execute`, `reflect`; the strategy that runs for a request.
- **Route decision**: the route plus a reason and its source (`router`, `override`, or
  `fallback`). Becomes the `route` trace event.
- **Node**: a named step of the production graph (`context`, `router`, `react`, `plan-execute`,
  `reflect`, `response`). Every trace event names the node that produced it.
- **Routing table**: the list of routes with the kind of request each suits, kept in the router's
  instructions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of `POST /chat` replies (success, iteration limit, and `run_failed`) hold
  exactly one `route` event, and every trace event in them has a `node` field.
- **SC-002**: A caller can send a request with only `message` and get an answer, without naming a strategy.
- **SC-003**: Over a fixed set of at least 6 scripted requests (2 per route), the graph runs the
  strategy the router chose in every case, and an override runs the requested strategy in every
  case.
- **SC-004**: A router failure never turns into a failed request: with the router scripted to fail,
  100% of requests still complete through `react`.
- **SC-005**: A request with an explicit `strategy` makes the same number of model calls as it does
  today (no router call added).
- **SC-006**: Requests that send `strategy` keep working without changes to the caller, apart from
  the new `route` event and `node` field in the trace.

## Assumptions

- The three strategies are the existing ones: `react`, `plan-execute`, and `reflect`, where
  `reflect` is ReAct wrapped with today's self-critique layer. Plan-and-execute with critique is no
  longer reachable from `POST /chat`; the arena and the bench may still build it directly.
- Node and route names are in English and match the strategy names (`context`, `router`, `react`,
  `plan-execute`, `reflect`, `response`), not the Portuguese names of the course example.
- The router uses the same model as the strategies; no new model setting is added.
- An override skips the router's model call rather than running it and discarding its choice, so
  forcing a strategy costs nothing extra and stays reproducible.
- The fallback route is `react`, because it is the current default and the cheapest strategy.
- Persistence of the exchange, the learning step in the background, and the context breakdown in
  the metrics stay as they are; they run after the graph and are not nodes.
- The arena and the bench keep forcing strategies by name; they gain the `node` field in their
  output, not the router.
- The existing tests that assert trace events are updated to the new event shape; strategy logic
  itself does not change.
