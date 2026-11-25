---

description: "Task list for the model fallback feature"
---

# Tasks: Model Fallback

**Input**: Design documents from `specs/013-model-fallback/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included. Constitution principle V requires every piece of new logic to ship with a test.
Tests use `node:test` through `tsx`, live next to the code (`*.test.ts`), and never touch the
network: `ScriptedChatModel` plays both models.

**Organization**: Tasks are grouped by user story, so each story can be built and tested on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Path Conventions

Single project: `src/` at the repository root. Tests sit next to their module.

---

## Phase 1: Setup

**Purpose**: Branch and a baseline.

- [x] T001 Create and switch to branch `013-model-fallback` from `012-unified-graph`, then run `npm run typecheck` and `npm test` to record a green baseline

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, the new error, and the test double that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 [P] In `src/domain/types.ts`:
  - add `| { type: "fallback"; from: string; to: string; error: string }` to `TraceEvent`, with a doc comment saying a model call switched from the primary to the fallback and that `error` is a class name, never provider text;
  - add `modelUsed: string | null` to `Metrics`, documented as "the model that answered the last finished call; null when none did";
  - add `cause?: string` to `RunError`, documented as "class name of the wrapped error".
- [x] T003 [P] In `src/domain/errors.ts`, add `ModelUnavailableError extends Error`, which is not a `DomainError`:
  - `name = "ModelUnavailableError"`;
  - `readonly causeName: string`;
  - the fixed message `"No model could answer"`;
  - `cause` set to the original error, through `super(message, { cause })`.
- [x] T004 In `src/agents/run-outcome.ts`, make `toRunError` return `{ name, message, cause: error.causeName }` when the error is a `ModelUnavailableError`, and keep the other cases as they are. Add `src/agents/run-outcome.test.ts` covering:
  - a plain `Error`;
  - a non-Error value;
  - a `ModelUnavailableError` whose `cause` is `"RateLimitError"`.
- [x] T005 Fix every `Metrics` literal the compiler flags after T002 by adding `modelUsed: null` as a temporary value, which US2 replaces. Start with these, then follow `npm run typecheck` until it is clean:
  - `src/agents/react.ts`, `src/agents/plan-and-execute.ts`, `src/agents/reflection.ts`;
  - `src/graph/production-graph.ts` (`responseNode`);
  - the test fixtures and `src/bench.ts` / `src/arena.ts`, if they build `Metrics`.
- [x] T006 [P] In `src/testing/scripted-chat-model.ts`, make `bindTools(tools, kwargs)` record what it is given in a shared `script.bound: { tools: unknown[]; kwargs: unknown }[]` list, exposed through a `bound` getter, so tests can assert that tools and `tool_choice` reached a model. Keep sharing the script and the callbacks as today. Extend `src/testing/scripted-chat-model.test.ts` for it.
- [x] T007 [P] Add a test helper `providerError(status: number, name: string, message?: string): Error` in `src/testing/provider-errors.ts`. It returns an `Error` carrying a numeric `status` and the given `name`, as `retryFailedCall` reads them. Examples: `providerError(429, "RateLimitError")`, `providerError(400, "BadRequestError")`, `providerError(503, "InternalServerError")`.

**Checkpoint**: Types compile with placeholders, and the test doubles are ready.

---

## Phase 3: User Story 1 - The reply still arrives when the primary model fails (Priority: P1) 🎯 MVP

**Goal**: A call that fails on the primary after its retries goes once to `OPENROUTER_MODEL_FALLBACK`, and the run answers.

**Independent Test**: A scripted primary that always fails and a scripted fallback that answers give `POST /chat` a 200 with the fallback's answer.

### Tests for User Story 1

- [x] T008 [P] [US1] Write `src/agents/resilient-model.test.ts`, failing at first, against [contracts/model-factory.md](contracts/model-factory.md). Use `createResilientModel` with `ScriptedChatModel` and `attempts: 1`, except where noted:
  - (a) Primary answers: the fallback's `calls` is 0.
  - (b) Primary throws `providerError(503, …)`: the fallback's answer is returned and the fallback's `calls` is 1.
  - (c) With `attempts: 2`, the primary fails once with 429 and then answers: the primary's `calls` is 2 and the fallback is not called. This test waits about 1 s of `p-retry` backoff.
  - (d) Primary throws `providerError(400, …)` with `attempts: 3`: the primary's `calls` is 1, then the fallback is used.
  - (e) The next `invoke` after a fallback tries the primary first again (FR-006).
  - (f) An aborted `AbortSignal`, or a `hangingTurn()` with a signal aborted mid-call: the abort error propagates unchanged and the fallback's `calls` is 0 (FR-005).
  - (g) `bindTools([tool], { tool_choice: "any" })`, then `invoke` with a failing primary: the fallback's `bound` holds the tool and the `tool_choice`.
  - (h) `withStructuredOutput(schema, { method: "functionCalling", includeRaw: true })` with a failing primary: the fallback's `parsed` result is returned.
  - (i) With no fallback, the primary fails: the error is a `ModelUnavailableError` with `causeName` equal to the primary error's `name`.
  - (j) Both fail: the error is a `ModelUnavailableError` with `causeName` equal to the primary error's `name` (research R7).
- [x] T009 [P] [US1] Extend `src/agents/model.test.ts` for settings:
  - `OPENROUTER_MODEL_FALLBACK` missing, `""`, `"   "`, or equal to `OPENROUTER_MODEL`, even with surrounding spaces: `fallbackModelOf` returns `undefined` and `createModel` does not throw (FR-002);
  - a set value is returned trimmed;
  - a missing `OPENROUTER_API_KEY` still throws `ConfigurationError`, naming only the field;
  - `createModel` returns an object with `bindTools` and `withStructuredOutput`.

### Implementation for User Story 1

- [x] T010 [US1] Create `src/agents/resilient-model.ts` following [research.md](research.md) R1–R4 and R7:
  - Export `PRIMARY_ATTEMPTS = 3` and `createResilientModel({ primary, fallback?, attempts? })`, where each model is `{ model: BaseChatModel; name: string }`.
  - Export `class ResilientChatModel extends BaseChatModel`:
    - `_llmType()` returns `"resilient"`;
    - `_generate` throws, since it is never used, because `invoke` is overridden;
    - `invoke(input, options)` runs `compose((m) => m)`;
    - `bindTools(tools, kwargs)` runs `compose((m) => m.bindTools!(tools, kwargs))`;
    - `withStructuredOutput(schema, config)` runs `compose((m) => m.withStructuredOutput(schema, config))`, typed with the same overloads as `BaseChatModel`.
  - `compose(shape)` builds three steps:
    1. `shape(primary.model).withConfig({ metadata: { opspilotModel: primary.name, opspilotModelRole: "primary" } }).withRetry({ stopAfterAttempt: attempts, onFailedAttempt: retryFailedCall })`;
    2. when a fallback is set, `.withFallbacks([shape(fallback.model).withConfig({ metadata: { opspilotModel: fallback.name, opspilotModelRole: "fallback" } })])`;
    3. a final step, as a `RunnableLambda` or a small `Runnable` subclass, that invokes the composition and, on error, rethrows the error unchanged when `config.signal?.aborted` or the error is an `AbortError`. Otherwise it throws `new ModelUnavailableError(error.name ?? "Error", error)`.
- [x] T011 [US1] Update `src/agents/model.ts`:
  - add `OPENROUTER_MODEL_FALLBACK: z.string().trim().optional()` to `ModelSettings`;
  - export a pure `fallbackModelOf(settings): string | undefined` that returns `undefined` for an empty value or one equal to `OPENROUTER_MODEL`;
  - build each `ChatOpenAI` from shared options (`apiKey`, `configuration: { baseURL }`, `temperature: 0`, `modelKwargs.provider.require_parameters`) plus `maxRetries: 0`, and remove `onFailedAttempt` from them, because the retry now lives in `withRetry`;
  - change `createModel`'s return type to `BaseChatModel` and return `createResilientModel({ primary: { model, name }, fallback })`;
  - keep `retryFailedCall` exported and unchanged.

  T008 and T009 must pass.
- [x] T012 [US1] Check the callers of `createModel()` compile and work with the `BaseChatModel` type: `src/index.ts`, `src/arena.ts`, `src/bench.ts`. Run `npm test`, which includes `react.test.ts`, `router.test.ts`, `plan-and-execute.test.ts`, `reflection.test.ts`, `server.test.ts`, `arena.test.ts` and `bench.test.ts`, and fix any regression, for example a strategy test that depended on ChatOpenAI-only API.
- [x] T013 [US1] Add a test to `src/http/server.test.ts` that builds the server with `createResilientModel({ primary: failing scripted, fallback: answering scripted, attempts: 1 })` and checks that `POST /chat` returns 200 with the fallback's answer (US1 scenario 1). Use `src/testing/test-server.ts` and follow how the existing tests inject a model.

**Checkpoint**: US1 works. Switches are not visible yet (`modelUsed` is still `null`).

---

## Phase 4: User Story 2 - The trace shows when and why the agent switched models (Priority: P2)

**Goal**: Each switch adds a `fallback` event with its `node`, and `metrics.modelUsed` names the model that answered.

**Independent Test**: With a failing primary and an answering fallback, the reply's trace holds one `fallback` event (`from`, `to`, `error`, `node`) and `metrics.modelUsed` is the fallback's name.

### Tests for User Story 2

- [x] T014 [P] [US2] Extend `src/agents/llm-counter.test.ts`, failing at first, using `createResilientModel` with scripted models and `attempts: 2`:
  - Primary fails twice, then the fallback answers: `count === 3`; `switches` is `[{ from: "p", to: "f", error: "RateLimitError" }]`; `modelUsed === "f"`.
  - Primary answers: `switches` is empty and `modelUsed === "p"`.
  - Every call fails: `modelUsed === null`.
  - A structured output call (`withStructuredOutput(..., { includeRaw: true })`) still records the switch, which shows that the metadata is inherited (research R5).
  - `fallbackEvents(switches)` maps each switch to `{ type: "fallback", from, to, error }` in order. This is a pure function.
- [x] T015 [P] [US2] Extend `src/http/schemas.test.ts`:
  - `TraceEventSchema` accepts `{ node: "react", type: "fallback", from: "p", to: "f", error: "RateLimitError" }`;
  - it rejects an empty `from`, `to`, or `error`;
  - `MetricsSchema` requires `modelUsed`, accepts `null`, and rejects `""`.

### Implementation for User Story 2

- [x] T016 [US2] In `src/agents/llm-counter.ts`, following research R5 and R6:
  - keep `count += 1` on every `handleChatModelStart`, retries included (FR-010);
  - read `metadata.opspilotModel` and `metadata.opspilotModelRole` from the `metadata` parameter and keep `runId -> model name`, plus the last primary name;
  - on a `fallback` start, push `{ from: lastPrimary, to: name, error: lastErrorName ?? "Error" }` to `switches`;
  - add `handleLLMError(error)`, which stores `error.name`;
  - in `handleLLMEnd(output, runId)`, set `modelUsed` from the run map, in addition to the prompt tokens.

  Export the `Switch` type and a pure `fallbackEvents(switches: readonly Switch[]): TraceEvent[]`. T014 must pass.
- [x] T017 [US2] In `src/http/schemas.ts`, add to `TraceEventSchema` the branch `z.object({ node: Node, type: z.literal("fallback"), from: z.string().min(1), to: z.string().min(1), error: z.string().min(1) })`, and add `modelUsed: z.string().min(1).nullable()` to `MetricsSchema` (FR-014). T015 must pass.
- [x] T018 [P] [US2] In `src/agents/react.ts`, build the trace as `[...fallbackEvents(counter.switches), ...messagesToTrace(messages)]` (research R8) and set `metrics.modelUsed: counter.modelUsed`. Add a test to `src/agents/react.test.ts`:
  - with a failing primary and an answering fallback, the trace starts with the `fallback` event and `metrics.modelUsed` is the fallback's name;
  - with a healthy primary, there is no `fallback` event (SC-004).
- [x] T019 [P] [US2] In `src/agents/plan-and-execute.ts`, insert the switches recorded during each planner, replanner, or executor call before the events that call produced, for example by draining the switches the counter recorded since the previous step. Set `metrics.modelUsed: counter.modelUsed`. Add a test to `src/agents/plan-and-execute.test.ts` where the planner's call falls back: the `fallback` event comes before the `plan` event.
- [x] T020 [P] [US2] In `src/agents/reflection.ts`:
  - place the critic's and the rewrite's switches just before the `critique` event, or before the rewritten answer;
  - keep the inner strategy's own `fallback` events as returned;
  - set `metrics.modelUsed` to the newest non-null of the inner result and the reflection counter.

  Add a test to `src/agents/reflection.test.ts` with a critic call that falls back.
- [x] T021 [US2] In `src/graph/router.ts`, add `switches: Switch[]` and `modelUsed: string | null` to `RouterResult` and fill them from the counter in `result(...)`. That covers the thrown case too: a failing router call still reports its switches. Add two tests to `src/graph/router.test.ts`:
  - a failing primary and an answering fallback: the decision is `source: "router"` and there is one switch;
  - a failing primary and a fallback that answers plain text instead of the forced tool call: the decision is the default route with `source: "fallback"`, there is exactly one switch, and the fallback's `calls` is 1, so no further fallback starts (spec edge case "fallback answers in a form the step cannot use").
- [x] T022 [US2] Carry the summarizer's switches and `modelUsed` through to the reply (research R9):
  - in `src/agents/history-summarizer.ts`, add `switches: Switch[]` and `modelUsed: string | null` to the `stored` and `failed` variants of `SummarizationStep`;
  - in `src/http/chat-service.ts` `summarize(...)`, fill them from `counter`, the way `llmCalls` and `promptTokens` are filled today.

  Extend `src/agents/history-summarizer.test.ts`, or the chat-service test that builds steps, so the new fields are covered.
- [x] T023 [US2] Update `src/graph/production-graph.ts`:
  - Add a `modelUsed: Annotation<string | null>({ reducer: (a, b) => b ?? a, default: () => null })` channel.
  - In the context node, put `tagNode(fallbackEvents(step.switches), "context")` before the `summarize` event and return `modelUsed: step.modelUsed` when the step is not `not_due`.
  - In the router node, put `tagNode(fallbackEvents(spent.switches), "router")` before the `route` event and return `modelUsed: spent.modelUsed`. An override returns `switches: []` and `modelUsed: null`.
  - In the strategy node, return `modelUsed: result.metrics.modelUsed`.
  - In `responseNode`, set `metrics.modelUsed: state.modelUsed`, replacing the T005 placeholder.

  Extend `src/graph/production-graph.test.ts`:
  - a router fallback gives a `fallback` event tagged `router` before `route`;
  - `modelUsed` ends as the strategy's model;
  - a run where only the router fell back reports the strategy's model.
- [x] T024 [US2] Add tests to `src/http/server.test.ts`, extending T013's setup:
  - The primary fails with `providerError(429, "RateLimitError", "PROVIDER-SECRET-TEXT")` and the fallback answers: the 200 body's trace holds a `fallback` event with `node`, `from`, `to`, and `error: "RateLimitError"`; `metrics.modelUsed` is the fallback's name; the body passes the `ChatReply` zod schema; and `JSON.stringify(body)` does not contain `"PROVIDER-SECRET-TEXT"` (FR-008).
  - A healthy primary: no `fallback` event, `modelUsed` is the primary (US2 scenario 2), and `metrics.llmCalls` equals the number of scripted turns the primary used, so retries add no call when nothing fails (SC-004).

**Checkpoint**: US1 and US2 work. Every switch is visible, with its node.

---

## Phase 5: User Story 3 - A clear 503 when no model can answer (Priority: P3)

**Goal**: A run that fails because no model can answer returns `503 model_unavailable` with the partial trace and metrics. Other failures stay `502`, and timeouts stay `504`.

**Independent Test**: With both scripted models always failing, `POST /chat` returns 503 with `error: "model_unavailable"`, the conversation id, and the partial trace and metrics.

### Tests for User Story 3

- [x] T025 [P] [US3] Extend `src/http/chat-reply.test.ts`, failing at first, for `toHttpReply`:
  - A `result` with `stopReason: "error"` and `error: { name: "ModelUnavailableError", message: "…", cause: "RateLimitError" }` gives status 503, `error: "model_unavailable"`, a fixed `message`, `runError: { name: "RateLimitError", message: RUN_ERROR_MESSAGE }`, the `conversationId`, and the trace and metrics with the context metrics merged in.
  - A `thrown` outcome with a `ModelUnavailableError` instance gives 503 without trace and metrics.
  - A run error named `"StoreOpenError"` stays 502 `run_failed`.
  - A `timeout` stays 504.
  - A `ModelUnavailableError` without `cause` uses `"Error"` as `runError.name`.
- [x] T026 [P] [US3] Extend `src/http/schemas.test.ts`: `ErrorReply` accepts the `model_unavailable` body, with or without `trace` and `metrics`, and rejects one without `conversationId`.

### Implementation for User Story 3

- [x] T027 [US3] In `src/http/schemas.ts`, add an `ErrorReply` branch `z.object({ error: z.literal("model_unavailable"), message: z.string(), runError: z.object({ name: z.string(), message: z.string() }), conversationId: z.string().min(1), trace: z.array(TraceEventSchema).optional(), metrics: MetricsSchema.optional() })`, as specified in [contracts/chat-api.md](contracts/chat-api.md). T026 must pass.
- [x] T028 [US3] In `src/http/chat-reply.ts`, add `MODEL_UNAVAILABLE_MESSAGE = "No model could answer; try again later"` and a pure `modelUnavailable(runError, outcome, partial?)` that has the same shape as `runFailed`, with status 503 and `runError.name = runError.cause ?? "Error"`. In `toHttpReply`, route both the `result` + `error` branch and the `thrown` branch to it when `runError.name === "ModelUnavailableError"`, compared against `ModelUnavailableError`'s name and not a loose string. Keep `failureOf` returning the error for the server log line. T025 must pass.
- [x] T029 [US3] Check that the log line in `src/http/chat-service.ts` / `src/http/chat-controller.ts` still holds no API key and no secret for a 503 (FR-013). If it prints `runError`, the cause name and the provider message are allowed, as they are today for the 502. If the log cannot be captured in tests, add an injectable logger there so T030(a2) can check it.
- [x] T030 [US3] Add tests to `src/http/server.test.ts`:
  - (a) Both scripted models always fail (`attempts: 1`) with `providerError(429, "RateLimitError", "PROVIDER-SECRET-TEXT")`: status 503, `error: "model_unavailable"`, the conversation id, the partial trace with `fallback` events tagged `router` and the strategy node, `metrics.modelUsed: null`, a body that passes `ErrorReply`, and nothing saved to the conversation.
  - (a2) Leak check for (a) (FR-008, FR-013, SC-005): build the server with a sentinel API key such as `"sk-test-SENTINEL"`, capture the log output the way the existing tests do (or inject a logger), and check that neither `JSON.stringify(body)` nor any captured log line contains `"sk-test-SENTINEL"`, and that the body does not contain `"PROVIDER-SECRET-TEXT"`.
  - (b) No fallback and the primary always fails: 503 (US3 scenario 2).
  - (c) A failure that does not come from a model stays 502, using an existing failing-dependency pattern in the file.
  - (d) A `hangingTurn()` primary with a short `timeoutMs`: 504 and no fallback call.

**Checkpoint**: All three stories work.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T031 [P] In `README.md`, add `OPENROUTER_MODEL_FALLBACK` to the settings table: optional, used by the HTTP API, `arena` and `bench`, with no default. Add one paragraph covering:
  - retries on the primary, then one attempt on the fallback;
  - the `fallback` trace event and `metrics.modelUsed`;
  - the 503 `model_unavailable` reply.

  Do not open `.env` or `.env.example`.
- [x] T032 [P] Check the reports in `src/bench.ts` and `src/arena.ts`: they still print correctly with the new `modelUsed` field, and `src/bench.test.ts` and `src/arena.test.ts` pass. They do not need to show switches, per the spec's Assumptions.
- [x] T033 Run `npm run typecheck` and `npm test`. Both must be green (constitution principle V).
- [ ] T034 Ask the user to add `OPENROUTER_MODEL_FALLBACK=` to `.env.example`, and a real value to `.env`, then run the live checks in [quickstart.md](quickstart.md) sections 2–4.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: has no dependencies.
- **Foundational (Phase 2)**: depends on Setup and blocks every story.
- **US1 (Phase 3)**: depends on Foundational. This is the MVP.
- **US2 (Phase 4)**: depends on US1, because the switches only exist once the fallback runs (T010).
- **US3 (Phase 5)**: depends on Foundational (T003, T004) and on T010 for the error translation. It can run in parallel with US2.
- **Polish (Phase 6)**: depends on every story.

### Within Each Story

- Tests come first and must fail before the implementation.
- In US1, T010 comes before T011, then T012, then T013.
- In US2, T016 and T017 come first. Then T018, T019 and T020 can run in parallel, followed by T021, T022, T023 and T024.
- In US3, T027 comes before T028, then T029, then T030.

### Parallel Opportunities

- Phase 2: T002, T003, T006 and T007 can run in parallel. T004 needs T003. T005 needs T002.
- US1: T008 and T009 can run in parallel.
- US2: T014 and T015 can run in parallel, and so can T018, T019 and T020, since each is a different strategy file.
- US3: T025 and T026 can run in parallel. The whole of US3 can run alongside US2, but `schemas.ts` (T017, T027) and `server.test.ts` (T024, T030) are shared, so merge in order.
- Polish: T031 and T032 can run in parallel.

---

## Parallel Example: User Story 2

```bash
# Tests first, in parallel:
Task: "T014 counter switches/modelUsed tests in src/agents/llm-counter.test.ts"
Task: "T015 schema tests in src/http/schemas.test.ts"

# After T016 + T017, the strategies in parallel:
Task: "T018 react fallback events in src/agents/react.ts"
Task: "T019 plan-execute fallback events in src/agents/plan-and-execute.ts"
Task: "T020 reflection fallback events in src/agents/reflection.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Finish Phase 1 and Phase 2.
2. Finish Phase 3 (US1).
3. **Stop and validate**: T013 is green, and `quickstart.md` section 2 answers with a broken primary. Switches are not traced yet.

### Incremental Delivery

1. Setup and Foundational, then US1: replies survive a primary outage (MVP).
2. Add US2: switches and `modelUsed` are visible.
3. Add US3: a clear 503 instead of a 502.
4. Polish: README, a green gate, and the live checks.

---

## Notes

- `withRetry` has no backoff option, so keep `attempts: 1` in tests, except T008(c) and T014 (research R11).
- The `fallback` event type is not `route.source: "fallback"` (research R8). Do not merge them.
- Never put provider error text in a trace event or a reply body. Only class names go there.
- Commit after each phase. Do not commit `.env`.

## Implementation notes

- `docs/code-examples/spec13-example.ts` was followed: both models get `withRetry` with 2 attempts (`MODEL_ATTEMPTS`), so the plan's 3 primary attempts and single fallback attempt changed (research R2, R3).
- The server tests of T013, T024 and T030 live in `src/http/model-fallback.test.ts`, which uses the real router and ReAct strategy over a resilient model, instead of growing `src/http/server.test.ts`.
- `toRunError` follows `error.cause` a few links, because agent middleware wraps a model error in a `MiddlewareError`.
- `LlmCallCounter.takeSwitches()` (audit A1) lets plan-execute and reflection place each step's switches before that step's events.
- `docs/openapi.yaml` gained the 503, the `fallback` event and `modelUsed`.
