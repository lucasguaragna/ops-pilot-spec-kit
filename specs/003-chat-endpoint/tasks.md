---

description: "Task list for the chat endpoint feature"
---

# Tasks: Chat Endpoint

**Input**: Design documents from `specs/003-chat-endpoint/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/chat-http.md](contracts/chat-http.md),
[quickstart.md](quickstart.md)

**Tests**: Requested. FR-013 asks for integration tests over real HTTP, and the constitution
requires a test for all new logic. Write each story's tests first and check that they fail before
writing the code.

**Organization**: Tasks are grouped by user story so each story can be built and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Path Conventions

Single project at the repository root: `src/` and tests next to the code as `*.test.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make `npm run dev` able to start a server that needs the OpenRouter key.

- [X] T001 In `package.json`, change the `dev` script from `tsx src/index.ts` to
  `node --env-file-if-exists=.env --import tsx src/index.ts`, matching `arena` and `bench`
  (research R7). Do not read or open `.env`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The error class, the registry, and the HTTP schemas that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Add `UnknownStrategyError` to `src/domain/errors.ts`. It must be
  `class UnknownStrategyError extends Error`, **not** `DomainError`: `DomainError` means a tool
  error the model can recover from. Give it `readonly strategy: string` and
  `readonly knownStrategies: readonly string[]`, set `this.name = "UnknownStrategyError"`, and use
  the message `Unknown strategy "<name>". Known: <a, b>`, following `ServiceNotFoundError`.
- [X] T003 [P] Write `src/agents/index.test.ts`, which must fail first. Use a fake registry with
  `{ react, "plan-execute" }` factories that return named stub strategies and cover these cases:
  - `createStrategy(registry, "react", deps, { reflect: false })` returns the `react` strategy.
  - `"plan-execute"` resolves.
  - `"chain-of-thought"`, `"React"`, `"reflect:react"`, `"toString"`, and `"constructor"` each
    throw `UnknownStrategyError` with `knownStrategies` `["react", "plan-execute"]`.
  - `Object.keys(strategyFactories)` is exactly `["react", "plan-execute"]` (FR-005).
- [X] T004 Create `src/agents/index.ts` exporting these names, with lookup only and no reflection
  yet (research R3):
  - `StrategyFactory = (dependencies: StrategyDependencies) => ReasoningStrategy`
  - `StrategyRegistry = Readonly<Record<string, StrategyFactory>>`
  - `strategyFactories = { react: createReactStrategy, "plan-execute": createPlanExecuteStrategy }`
  - the pure `createStrategy(registry, name, dependencies, { reflect })`, which looks the name up
    with `Object.hasOwn` and throws `UnknownStrategyError(name, Object.keys(registry))` when it is
    missing

  Import `StrategyDependencies` from `src/agents/react.ts`. T003 must pass.
- [X] T005 [P] Write `src/http/schemas.test.ts`, which must fail first. Check that `ChatRequest`:
  - accepts `{ message: "hi", reflect: false }` and fills in `strategy: "react"`
  - rejects a missing `reflect`, `reflect: "true"`, `message: ""`, and `message: "   "`
  - strips extra fields
  - keeps `strategy: "React"` as is, because the name is checked later

  Also check that `toIssues` maps a `ZodError` to `{ path, message }[]`.
- [X] T006 Create `src/http/schemas.ts` with these schemas (research R5, data-model):
  - `ChatRequest = z.object({ message: z.string().trim().min(1), strategy: z.string().default("react"), reflect: z.boolean() })`
  - `TraceEventSchema` and `MetricsSchema`, mirroring `src/domain/types.ts`, with "Non-negative
    integers" for `llmCalls` and `latencyMs`
  - `ChatReply`: `answer` is a string or null, `stopReason` is `z.enum(["completed", "iteration_limit"])`,
    plus `trace` and `metrics`
  - `ErrorReply`: a discriminated union on `error` with these kinds:
    - `invalid_body` with `issues: { path: (string | number)[], message: string }[]`
    - `unknown_strategy` with `strategy` and `knownStrategies`
    - `run_failed` with `runError: { name, message }` and optional `trace` and `metrics`
    - `timeout` with `timeoutMs`
    - `internal`

    Every kind also has `message: string`.
  - the pure `toIssues(error: z.ZodError)` helper

  T005 must pass.
- [X] T007 Create `src/http/server.ts` exporting `AppSettings` and `createApp(settings)`, per
  [contracts/chat-http.md](contracts/chat-http.md):
  - `AppSettings` is `{ registry, createDependencies, timeoutMs?, maxIterations? }`, with defaults
    `180_000` and `10`.
  - `createApp` uses `express.json()` and ends with a final error middleware that replies 500
    `{ error: "internal", message: "Internal server error" }`, with no stack and no error text
    (FR-011).
  - Leave the `POST /chat` route for US1. Other paths fall through to Express's 404.

**Checkpoint**: Registry, schemas, and app factory exist, and `npm run typecheck` and `npm test` pass.

---

## Phase 3: User Story 1 - Ask OpsPilot a question over HTTP (Priority: P1) 🎯 MVP

**Goal**: `POST /chat` with a valid body runs the chosen strategy and replies 200 with
`{ answer, stopReason, trace, metrics }`.

**Independent Test**: Start `createApp` on port 0 with a fake registry whose strategy returns a
fixed result, then POST `{ "message": "Which alerts are firing?", "reflect": false }` and check the
200 body.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST and make sure they FAIL before implementation**

- [X] T008 [P] [US1] Write `src/http/chat-reply.test.ts`. Check that `toHttpReply`:
  - turns `{ kind: "result", result }` with `stopReason: "completed"` into status 200 with a body
    holding `answer`, `stopReason`, `trace`, and `metrics`
  - turns `stopReason: "iteration_limit"` into status 200 with `answer: null`
  - returns a body that passes `ChatReply.parse`
- [X] T009 [P] [US1] Write `src/http/server.test.ts`.
  - Add a `startServer(settings)` helper that calls `createApp(settings).listen(0)`, returns the
    base URL, and closes the server in `after`.
  - Add a `fakeStrategy(name, result)` helper that records each `(input, options)` call.
  - Add `postChat(baseUrl, body)` using the global `fetch` with a JSON header.

  Tests:
  - No `strategy` runs the fake registered as `react`, with the input `"Which alerts are firing?"`,
    and gets 200 with the fixed answer, trace, and metrics and `stopReason` `completed`.
  - `"strategy": "plan-execute"` runs the `plan-execute` fake.
  - An iteration-limit fake gets 200 with `answer: null` and the full trace.
  - The strategy receives `maxIterations: 10`.
  - `GET /chat` and `POST /other` get 404.

  Use no network and no real model.

### Implementation for User Story 1

- [X] T010 [P] [US1] Create `src/http/chat-reply.ts` with the pure
  `toHttpReply(outcome): { status: number; body: unknown }` for a run that finished. For
  `{ kind: "result" }` with `completed` or `iteration_limit`, return 200 and the `ChatReply` body.
  Leave clear `switch` cases for the outcome kinds US3 adds. T008 must pass.
- [X] T011 [US1] Create `src/http/chat-service.ts` with
  `runChat(settings, request): Promise<ChatOutcome>`. It calls `createStrategy` with the following
  arguments:
  - `settings.registry`
  - `request.strategy`
  - `settings.createDependencies()`
  - `{ reflect: request.reflect }`

  It then runs the strategy with `{ maxIterations: settings.maxIterations }` and returns
  `{ kind: "result", result }`. Export `ChatOutcome` as a discriminated union on `kind`. US1 needs
  only `result`; US3 adds `thrown` and `timeout`.
- [X] T012 [US1] Create `src/http/chat-controller.ts` with the handler `postChat(settings)`.
  1. Run `ChatRequest.safeParse(req.body)`. On failure, reply 400
     `{ error: "invalid_body", message: "The request body is invalid", issues: toIssues(error) }`.
  2. Otherwise call `runChat` and then `toHttpReply`.
  3. Before sending, validate the body with the schema for its status (`ChatReply` for 200,
     `ErrorReply` otherwise). A schema failure throws, and the error middleware turns it into a 500
     (FR-010).
- [X] T013 [US1] Mount `app.post("/chat", postChat(settings))` in `src/http/server.ts` before the
  error middleware, with settings resolved to their defaults. T009 must pass.
- [X] T014 [US1] Write `src/index.ts` as the entry point (research R7).
  1. Parse `PORT` from `process.env` with zod (`z.coerce.number().int().positive().default(3000)`)
     and exit with a readable message on failure, never printing values.
  2. Build the model once with `createModel()`.
  3. Set `createDependencies` to
     `() => ({ model, tools: [...createTools(createStore(createJsonFileBackend()))] })`, as
     `src/arena.ts` does.
  4. Call `createApp({ registry: strategyFactories, createDependencies }).listen(port)` and log the
     URL.

**Checkpoint**: The MVP works. `npm test` passes, and a manual `curl` with `"reflect": false`
returns 200 (quickstart §2, first row).

---

## Phase 4: User Story 2 - Turn reflection on per request (Priority: P2)

**Goal**: `"reflect": true` wraps the chosen strategy with `withReflection`, and the arena uses the
same registry (SC-005).

**Independent Test**: POST the same message with `reflect` true and then false to a server whose
fake registry uses `ScriptedChatModel` scripted with an approving verdict. Only the reflected reply
has a `critique` event.

### Tests for User Story 2 ⚠️

- [X] T015 [P] [US2] Extend `src/agents/index.test.ts`:
  - With `{ reflect: true }`, `createStrategy` returns a strategy named `reflect:react` whose run
    calls the base strategy and the critic. Use a `ScriptedChatModel` from
    `src/testing/scripted-chat-model.ts` whose turn is an approving structured verdict, matching
    `src/agents/reflection.test.ts`.
  - With `{ reflect: false }`, the strategy is named `react`.
- [X] T016 [P] [US2] Extend `src/http/server.test.ts`. Use fake dependencies with a
  `ScriptedChatModel` scripted to approve.
  - `"reflect": true` gets 200 with a `critique` event in `trace`.
  - `"reflect": false` gets 200 with no `critique` event.
- [X] T017 [P] [US2] Update `src/arena.test.ts` so that `parseArenaArgs` still accepts `react`,
  `plan-execute`, `reflect:react`, and `reflect:plan-execute` and rejects `foo`, with names now
  derived from the shared registry.

### Implementation for User Story 2

- [X] T018 [US2] In `src/agents/index.ts`, make `createStrategy` return
  `withReflection(base, { model: dependencies.model })` when `reflect` is true. T015 and T016 must
  pass.
- [X] T019 [US2] Move `src/arena.ts` onto the shared registry.
  1. Remove the local `strategyFactories`.
  2. Build the arena names as
     `[...Object.keys(strategyFactories), ...Object.keys(strategyFactories).map((n) => "reflect:" + n)]`
     for the `StrategyName` zod enum.
  3. In `runArena`, strip a `reflect:` prefix and call
     `createStrategy(strategyFactories, base, deps, { reflect })`.

  Keep CLI behavior and output unchanged. T017 must pass.

**Checkpoint**: US1 and US2 both work. `npm run arena -- --strategies react,reflect:react` behaves as
before (quickstart §3).

---

## Phase 5: User Story 3 - Get a clear error for a bad request or a slow run (Priority: P3)

**Goal**: Each failure kind has its own status: 400 invalid body or bad JSON, 422 unknown strategy,
502 run failed, and 504 timeout. A timeout also cancels the run through `RunOptions.signal`.

**Independent Test**: Start the server with fake strategies and `timeoutMs: 50`, send each bad
request, and check the status and body against [contracts/chat-http.md](contracts/chat-http.md).

### Tests for User Story 3 ⚠️

- [X] T020 [P] [US3] Extend `src/agents/react.test.ts`. With an already aborted
  `AbortController().signal` in `RunOptions`, `ScriptedChatModel` records no call and the result
  has `stopReason: "error"`. Add a mid-run case (FR-009a): the model asks for a fake tool, the tool
  aborts the controller and returns, and then `ScriptedChatModel` records no second call and the
  result has `stopReason: "error"`.
- [X] T021 [P] [US3] Extend `src/agents/plan-and-execute.test.ts`:
  - Pre-aborted case: no planner call and `stopReason: "error"`.
  - Mid-run case (FR-009a): the plan has two steps that call fake tools `first` and `second`.
    `first` aborts the controller and returns. `second` is never invoked, no model call follows
    `first`, and the result has `stopReason: "error"`.
- [X] T022 [P] [US3] Extend `src/agents/reflection.test.ts` with three cases:
  - The base strategy receives the same `signal` in its `RunOptions`.
  - A base fake that aborts the controller and returns a completed answer leads to no critic call,
    and the run returns `stopReason: "error"`.
  - A critic model that aborts the controller and then rejects leads to `stopReason: "error"`,
    not `completed` with the kept answer, and no rewrite call.
- [X] T023 [P] [US3] Write `src/http/chat-service.test.ts`. Check that `runWithTimeout(run, ms)`:
  - resolves `{ kind: "done", value }` when the run finishes first
  - resolves `{ kind: "timeout" }` after about `ms` when the run never finishes, with the signal it
    passed in now `aborted`
  - resolves `{ kind: "thrown", error }` when the run rejects
  - does not keep the test process alive, so the timer is cleared
- [X] T024 [P] [US3] Extend `src/http/chat-reply.test.ts`:
  - `{ kind: "result" }` with `stopReason: "error"` gives 502
    `{ error: "run_failed", runError: { name, message }, trace, metrics }`.
  - `{ kind: "thrown", error }` gives 502 with `runError` from `toRunError` and no `trace` or
    `metrics`.
  - `{ kind: "timeout", timeoutMs }` gives 504
    `{ error: "timeout", message: "The run did not finish within <ms> ms", timeoutMs }`.
  - `UnknownStrategyError` gives 422 with `strategy` and `knownStrategies`.
  - No body contains a `stack` key.
- [X] T025 [US3] Extend `src/http/server.test.ts` with these cases, using `timeoutMs: 50` (FR-013,
  SC-002):
  - **400 with field issues** for: missing `message`; `message: "   "`; missing `reflect`;
    `reflect: "true"`; `message: 42`.
  - **400 for bad JSON**: body `not json` gets `invalid_body` with one issue at `path: []`.
  - **400 for no body**: a request with no body gets 400.
  - **400 before 422**: an invalid body that also names `strategy: "chain-of-thought"` gets 400.
  - **Extra fields**: they are ignored, and the reply is 200.
  - **422** for `chain-of-thought`, `React`, `reflect:react`, and `toString`, with
    `knownStrategies` listed.
  - **502 from an error result**: an error-result fake gets 502 with `trace`.
  - **502 from a throw**: a throwing fake gets 502 without `trace` and with no `stack` in the raw
    text.
  - **504**: a fake that waits on `options.signal` gets 504. Assert that the fake saw
    `signal.aborted === true` and that the reply came within `timeoutMs + 1000` ms (SC-003).

### Implementation for User Story 3

- [X] T026 [US3] Add `signal?: AbortSignal` to `RunOptions` in `src/domain/types.ts`, with the
  comment "Once aborted, no new model or tool call starts" (data-model). Existing callers stay
  valid.
- [X] T027 [P] [US3] In `src/agents/react.ts`, pass `signal: options.signal` into the config of
  `agent.stream(...)` (line ~67). T020 must pass.
- [X] T028 [P] [US3] In `src/agents/plan-and-execute.ts`, pass `signal: options.signal` into the
  config of `graph.stream(...)` (line ~230). In `runToolCall` (line ~140), rethrow the error when
  `config.signal?.aborted` is true, so an abort is not turned into an `Error: ...` observation.
  T021 must pass.
- [X] T029 [P] [US3] In `src/agents/reflection.ts`:
  - Add `signal: runOptions.signal` to the critic and rewrite `config` (line ~139).
  - Call `runOptions.signal?.throwIfAborted()` before each critic call and each re-run of the base
    strategy.
  - Before `keepAnswer` on a critic or rewrite error (line ~162), call
    `runOptions.signal?.throwIfAborted()`, so an abort reaches the outer catch and returns
    `stopReason: "error"` instead of a kept answer.
  - Keep passing `runOptions` unchanged to `strategy.run`.

  T022 must pass.
- [X] T030 [US3] In `src/http/chat-service.ts`:
  - Add the exported `runWithTimeout(run: (signal: AbortSignal) => Promise<T>, timeoutMs)`
    (research R2). It creates an `AbortController`, races the run against a `setTimeout`, aborts
    on timeout, and always calls `clearTimeout`.
  - Extend `ChatOutcome` with `{ kind: "thrown"; error: unknown }` and
    `{ kind: "timeout"; timeoutMs: number }`.
  - Make `runChat` pass `{ maxIterations, signal }` through `runWithTimeout(..., settings.timeoutMs)`.
  - Leave `UnknownStrategyError` to propagate: it is thrown before the run starts.

  T023 must pass.
- [X] T031 [US3] In `src/http/chat-reply.ts`, add the cases for 502 `run_failed` (from a result with
  `stopReason: "error"` or from `thrown`, through `toRunError` in `src/agents/run-outcome.ts`) and
  for 504 `timeout`. Add the pure `unknownStrategyReply(error: UnknownStrategyError)` for 422.
  Bodies carry `name` and `message` only (FR-011). T024 must pass.
- [X] T032 [US3] In `src/http/chat-controller.ts`, catch `UnknownStrategyError` around `runChat` and
  reply with `unknownStrategyReply`. Any other error is passed to `next(error)`.
- [X] T033 [US3] In `src/http/server.ts`, extend the error middleware. An error with
  `type === "entity.parse.failed"` gets 400
  `{ error: "invalid_body", message: "The request body is invalid", issues: [{ path: [], message: "The body is not valid JSON" }] }`.
  Everything else still gets the generic 500 (research R4). T025 must pass.

**Checkpoint**: All three stories work, and every status in the contract is covered by a test.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T034 [P] Fix the stale note in `specs/003-chat-endpoint/checklists/requirements.md`. It says a
  timed-out run "is not cancelled"; it should say the run is cancelled through a signal, per the
  clarification.
- [X] T035 Run `npm run typecheck` and `npm test`. Both must be green, and the whole suite must
  finish in under 5 seconds with no network (SC-004).
- [X] T036 Run [quickstart.md](quickstart.md) §2 and §3 by hand: start with `npm run dev`, send the
  `curl` rows, and run the arena check. Record any gap in the spec or the code.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: comes after Setup and blocks every story.
- **US1 (Phase 3)**: comes after Foundational. It is the MVP.
- **US2 (Phase 4)**: comes after US1, because it uses the route and the `server.test.ts` harness.
- **US3 (Phase 5)**: comes after US1. It is independent of US2 except for `src/agents/index.ts`
  (T018) and `src/arena.ts` (T019), which US3 does not touch.
- **Polish (Phase 6)**: comes after all stories.

### User Story Dependencies

- **US1**: needs only Phase 2.
- **US2**: needs the US1 route. Its reflection logic in `src/agents/index.ts` needs nothing from US3.
- **US3**: needs the US1 route and the controller. T026 (`RunOptions.signal`) blocks T027 to T030.

### Within Each User Story

- Write the tests first and make sure they fail.
- Order: schemas and types, then the pure mappers, then the service, then the controller and the
  route, then the entry point.

### Task-Level Dependencies

- T004 needs T002 and T003.
- T006 needs T005.
- T007 needs T006.
- T010 needs T008.
- T011 needs T004.
- T012 needs T010 and T011.
- T013 needs T012 and T009.
- T014 needs T013.
- T018 needs T015.
- T019 needs T018 and T017.
- T027, T028, and T029 need T026.
- T030 needs T026 and T023.
- T031 needs T024.
- T032 needs T031.
- T033 needs T032 and T025.

### Parallel Opportunities

- **Phase 2**: T002, T003, and T005 can run together.
- **US1**: T008 and T009 can run together, then T010 can run alongside T011.
- **US2**: T015, T016, and T017 can run together.
- **US3**:
  - T020 to T024 can run together.
  - After T026, T027, T028, and T029 can run together.

---

## Parallel Example: User Story 3

```bash
# Tests first, all in different files:
Task: "T020 Pre-aborted signal test in src/agents/react.test.ts"
Task: "T021 Pre-aborted signal test in src/agents/plan-and-execute.test.ts"
Task: "T022 Signal propagation test in src/agents/reflection.test.ts"
Task: "T023 runWithTimeout tests in src/http/chat-service.test.ts"
Task: "T024 Error mapping tests in src/http/chat-reply.test.ts"

# After T026 (RunOptions.signal):
Task: "T027 Pass signal in src/agents/react.ts"
Task: "T028 Pass signal in src/agents/plan-and-execute.ts"
Task: "T029 Pass signal and throwIfAborted in src/agents/reflection.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1, then Phase 2.
2. Phase 3 (US1).
3. **Stop and validate**: run `npm test`, then `curl` with `"reflect": false` against `npm run dev`.

Before US2, `reflect: true` runs the plain strategy. Before US3, a run that throws gets the generic
500 and there is no timeout.

### Incremental Delivery

1. Setup and Foundational give the registry and schemas.
2. US1 gives the endpoint answering over HTTP (MVP).
3. US2 adds per-request reflection and the shared registry in the arena (SC-005).
4. US3 adds the distinct error statuses and cancellation on timeout (SC-002, SC-003).
5. Polish runs the full checks and the quickstart.

---

## Notes

- `[P]` means a different file with no dependency on unfinished tasks.
- Never read `.env`. `npm run dev` loads it through Node's `--env-file-if-exists`.
- Fake strategies live inside `src/http/server.test.ts`, with no real model and no network.
- Commit after each phase checkpoint, when asked.
