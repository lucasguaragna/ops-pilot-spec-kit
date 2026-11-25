# Research: Unified Graph

No `NEEDS CLARIFICATION` was left in the Technical Context. The decisions below settle the design
questions that the spec leaves to the plan. The LangGraph API was checked against the current
LangGraph JS docs (Context7, `/websites/langchain_oss_javascript_langgraph`): `addConditionalEdges`
takes a routing function plus an optional map from its output to node names, and `Annotation.Root`
takes a reducer per channel. This is the same API `plan-and-execute.ts` already uses.

## R1: Node and route names

- **Decision**: Nodes are `context`, `router`, `react`, `plan-execute`, `reflect`, `response`.
  Route names are the three strategy nodes, and they are also the names `strategy` accepts.
- **Rationale**: One name per route works for the override, the conditional edge, the `route` event,
  and the `node` field, with no mapping. `plan-execute` is already the registry key and the name
  callers send. English follows the project's rule for identifiers.
- **Alternatives considered**: The example's `contexto`/`roteador`/`resposta`/`planExecute`.
  Rejected because they are Portuguese identifiers, and `planExecute` would differ from the existing
  `strategy: "plan-execute"`.

## R2: The router call

- **Decision**: `model.withStructuredOutput(routeAnswerSchema, { name: "route", method:
  "functionCalling", includeRaw: true })`, called once. `routeAnswerSchema` is
  `z.object({ route: z.enum(ROUTES), reason: z.string() })`. The answer goes through the pure
  `decideRoute`: a valid answer is `source: "router"`; `parsed: null`, an invalid answer, or a thrown
  error is `source: "fallback"` with route `react`. An abort is the only error that propagates, so a
  timeout stops the run instead of starting a fallback.
- **Rationale**: `functionCalling` with `includeRaw` is how the planner, replanner, and critic call
  structured output today. They work on every OpenRouter model with tools, and they return
  `parsed: null` instead of throwing on bad output. A single attempt keeps the router's cost at one
  call (SC-005, FR-003), and the fallback makes a miss harmless.
- **Alternatives considered**: The `structured()` helper with 5 attempts. Rejected because a bad
  route is cheap to recover from (react is a fine default), and 5 calls would cost more than many
  whole runs. Also rejected: plain text with a regex, which is not validated output.

## R3: What the router reads and its prompt

- **Decision**: The router reads the composed input that the strategy will read (memories, summary,
  recent messages, request). Its system prompt is `ROUTER_PROMPT`, which holds a Markdown table:

  | Route | Use it when | Example |
  | --- | --- | --- |
  | `react` | One lookup or one action, a direct question | "What is firing now?" |
  | `plan-execute` | Several steps, several items, or an ordered sequence of actions | "Open an incident for each critical alert, then summarize" |
  | `reflect` | The answer must be checked before it is given: summaries, postmortems, recommendations | "Write the summary of INC-002 for the status page" |

  The prompt ends with the rule "when unsure, choose react".
- **Rationale**: Follow-ups ("do the same for the others") need the history to be routed right. The
  context is already capped by 011 (summary plus at most 14 messages). The table puts the rule in
  one place, as FR-004 asks, and it is exported so a test can check that every route is in it.
- **Alternatives considered**: Only the current message. Rejected because follow-ups would be
  misrouted. Also rejected: a separate routing config file, which is one more thing to keep in sync.

## R4: Where the `node` field comes from

- **Decision**: Strategies stay unchanged and keep emitting plain `TraceEvent`s. The graph tags
  them with the pure `tagNode(events, node)`, which gives `NodeTraceEvent = TraceEvent & { node:
  NodeName }`. The context node tags `summarize` with `context`, the router tags `route` with
  `router`, and each strategy node tags its events with its own name.
- **Rationale**: The strategies, arena, and bench stay untouched. A strategy has no idea it runs in
  a graph, so it cannot know its node, and the graph does.
- **Alternatives considered**: A required `node` on the domain `TraceEvent`. Rejected because every
  strategy and test would have to change, and the arena and bench would have to invent nodes.

## R5: The final `answer` event and the response node

- **Decision**: The pure `finalizeTrace(strategyTrace, result)` turns the strategy's last `answer`
  event into a `response` event when the run completed. Earlier `answer` events (rejected drafts of
  `reflect`) keep the strategy's node. A run that hit the iteration limit or failed has no final
  answer, so its trace passes through as it is. The response node then builds the graph's
  `RunResult` from the strategy's result, with the metrics of context, router, and strategy summed.
  `withSummarization` in `chat-reply.ts` is removed, because the context node now adds the
  `summarize` event and the summarizer's calls.
- **Rationale**: FR-008 says the final answer comes from `response`. Retagging keeps one `answer`
  event, so no duplicate shows up in the trace.
- **Alternatives considered**: Appending a second `answer` event from `response`. Rejected because
  the answer would appear twice.

## R6: What stays outside the graph, and the timeout

- **Decision**: The service still runs, before the graph and in this order: the route check
  (`requestedRoute`, which throws `UnknownStrategyError`), `summaryOf`/`messagesAfter` (which throw
  `ConversationNotFoundError`), recall (which throws `EmbeddingError`), and `conversations.create()`.
  The graph runs under `runWithTimeout(settings.timeoutMs)` as a whole: context (summarization),
  router, strategy, response. Saving the exchange, the background learning step, and the context
  breakdown stay after the graph.
- **Rationale**: Those three errors must keep their status codes and must leave no empty
  conversation behind, which is only true if they happen before the run. Summarization never
  throws, so it can live in the graph. This is a small change from 011: the summarization's time now
  counts toward the request timeout. It keeps its own 30 s cap, so at most 30 of the 180 s go to it.
- **Alternatives considered**: Recall inside the context node. Rejected because an `EmbeddingError`
  would become a `502 run_failed` and would create the conversation first. Also rejected: a timer
  that covers only router plus strategy, which would need two timers and adds nothing for the user.

## R7: Building the strategies per route

- **Decision**: `createRouteStrategy(registry, route, dependencies)` in `src/agents/index.ts`. It
  maps `react` and `plan-execute` to `createStrategy(registry, route, deps, { reflect: false })`, and
  `reflect` to `createStrategy(registry, "react", deps, { reflect: true })`. The graph gets a lazy
  `strategyFor(route)`, so only the chosen strategy is built.
- **Rationale**: It reuses the registry, so the test server's fake strategies still plug in.
  Building lazily avoids creating the critic's structured model when it is not used.
- **Alternatives considered**: Adding `reflect` to `strategyFactories`. Rejected because the arena
  builds `reflect:<name>` from the base names and would list `reflect:reflect`.

## R8: The override and the `reflect` alias

- **Decision**: The pure `requestedRoute({ strategy, reflect })` returns `Route | undefined`:
  `reflect: true` gives `"reflect"`, a known `strategy` gives itself, and no strategy gives
  `undefined` (the router decides). An unknown name throws `UnknownStrategyError(name, ROUTES)`. The
  conflict (`reflect: true` with another strategy) is a `superRefine` issue in `ChatRequest`, at path
  `["reflect"]`, so it is a `400` before the service runs. For an override the router node makes no
  call and emits `{ source: "override", reason: "Requested by the caller" }`.
- **Rationale**: The conflict is a malformed request, so it belongs to the boundary schema. An
  unknown name stays a `422`, as today, so the existing contract and its tests still hold.
- **Alternatives considered**: Silently letting `reflect` win over `strategy`. Rejected because a
  caller that sends both would get a strategy it did not ask for, without being told.

## R9: Metrics

- **Decision**: The graph state sums `llmCalls` and `promptTokens` (with `addPromptTokens`) across
  nodes. The context node adds the summarizer's calls, the router node adds its own (counted with an
  `LlmCallCounter` on its call only), and the strategy node adds the strategy's `metrics`.
  `latencyMs` is the whole graph's run time. The context breakdown's `system` is the chosen
  strategy's `systemPrompt`; the router prompt is not part of the agent's starting context, so it
  is not in the breakdown.
- **Rationale**: FR-011 requires that the router's call is counted. The breakdown stays an estimate
  of what the agent reads, which is what 010 defined.

## R10: Nested graphs and the signal

- **Decision**: Strategy nodes call `strategy.run(input, { maxIterations, signal })` with the
  signal of the graph invocation (`config.signal`). Plan-and-execute's own `StateGraph` runs inside
  the node as a nested invocation.
- **Rationale**: Nested graphs run fine in LangGraph JS. The parent graph has only a few steps, so
  the default recursion limit is never reached. The signal makes an abort stop the strategy, as it
  does today.
