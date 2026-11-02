# Tasks: Reasoning Nucleus

**Input**: Design documents from `specs/001-reasoning-nucleus/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested by the spec (FR-014) for the store and trace formatting, and required by
constitution principle V for all new logic. Every test uses no network. Strategy tests use
`FakeToolCallingChatModel`-style fakes from `@langchain/core/utils/testing`, or a local fake if that
export does not fit. Write each test first and confirm it fails.

**Organization**: Tasks are grouped by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story from spec.md

---

## Phase 1: Setup

**Purpose**: Scripts and folders

- [X] T001 Add `"seed": "tsx src/store/seed.ts"` to `scripts`, and change `arena` to `node --env-file-if-exists=.env --import tsx src/arena.ts` in package.json
- [X] T002 Create folders `src/domain`, `src/store`, `src/trace`, and `src/agents`

---

## Phase 2: Foundational

**Purpose**: Shared types and errors. No user story can begin until this is complete.

- [X] T003 [P] Define zod schemas in src/domain/schemas.ts: `Severity` (`low`, `medium`, `high`, `critical`), `AlertStatus` (`firing`, `resolved`), `IncidentStatus` (`open`, `resolved`), Service `name` ("Non-empty, unique"), Alert, Incident, and tool inputs from contracts/tools.md
- [X] T004 [P] Define domain errors in src/domain/errors.ts: `ServiceNotFoundError`, `IncidentNotFoundError`, `IncidentAlreadyResolvedError`, and `ConfigurationError` ("names the missing setting, never its value")
- [X] T005 Define `TraceEvent`, `Metrics`, `RunError`, the discriminated `RunResult`, `RunOptions`, and `ReasoningStrategy` in src/domain/types.ts, exactly as in data-model.md and contracts/reasoning-strategy.md

**Checkpoint**: `npm run typecheck` passes

---

## Phase 3: User Story 1 - Operate alerts and incidents through shared tools (Priority: P1) 🎯 MVP

**Goal**: Seeded data and three validated tools, working without a provider

**Independent Test**: `npm run seed` prints 5 services, 3 firing alerts, and 3 resolved alerts, and
`npm test` passes without network

### Tests for User Story 1

- [X] T006 [P] [US1] Write store tests in src/store/in-memory-store.test.ts: seed counts, listing by status, opening an incident with sequential `INC-001` identifiers, resolving, `ServiceNotFoundError`, `IncidentNotFoundError`, `IncidentAlreadyResolvedError`, previous state unchanged after each transition, and reset restoring the seed
- [X] T007 [P] [US1] Write tool tests in src/agents/tools.test.ts: valid calls return JSON text, invalid input is rejected with data unchanged, and domain errors return text that starts with `Error:`

### Implementation for User Story 1

- [X] T008 [P] [US1] Create src/store/seed-data.ts with 5 services and 6 alerts, 3 `firing` and 3 `resolved`, across varied services and severities, using fictional names, and no incidents
- [X] T009 [US1] Implement pure transitions over an immutable `StoreState` and a thin `createStore` wrapper with reset in src/store/in-memory-store.ts
- [X] T010 [US1] Implement `createTools(store)` returning `list_alerts`, `open_incident`, and `resolve_incident` per contracts/tools.md in src/agents/tools.ts
- [X] T011 [US1] Implement the seed command per contracts/arena-cli.md in src/store/seed.ts

**Checkpoint**: User Story 1 works alone without a provider

---

## Phase 4: User Story 2 - Answer a request with the ReAct strategy (Priority: P2)

**Goal**: Request to answer through tools, with trace, metrics, and limits

**Independent Test**: With a fake model, a tool-using run returns a completed result with an ordered
trace, and a looping model ends with `iteration_limit`

### Tests for User Story 2

- [X] T012 [P] [US2] Write mapping tests in src/trace/from-messages.test.ts: AI text becomes `thought` or `answer`, each tool call becomes an `action` with `tool` and `args`, and each tool message becomes an `observation`
- [X] T013 [P] [US2] Write trace formatting tests in src/trace/format.test.ts: one case per event type (`thought`, `action`, `observation`, `plan`, `critique`, `answer`) and metrics output
- [X] T014 [P] [US2] Write counter tests in src/agents/llm-counter.test.ts: the count matches calls made through a fake model (SC-006)
- [X] T015 [P] [US2] Write model factory tests in src/agents/model.test.ts: a missing setting throws `ConfigurationError` naming that setting, and the error text never includes the key value
- [X] T016 [US2] Write strategy tests in src/agents/react.test.ts with a fake model: completed run, `iteration_limit` run through an error named `ModelCallLimitMiddlewareError`, and `error` run keeping the partial trace

### Implementation for User Story 2

- [X] T017 [P] [US2] Implement the pure `messagesToTrace` in src/trace/from-messages.ts
- [X] T018 [P] [US2] Implement pure trace and metrics formatting in src/trace/format.ts
- [X] T019 [P] [US2] Implement a callback handler counting `handleChatModelStart` in src/agents/llm-counter.ts
- [X] T020 [P] [US2] Implement the single model factory in src/agents/model.ts: validate `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` with zod when called, use `ChatOpenAI`, `configuration.baseURL` of `https://openrouter.ai/api/v1`, and `temperature: 0`
- [X] T021 [US2] Implement `createReactStrategy({ model, tools })` named `react` in src/agents/react.ts using `createAgent`, `modelCallLimitMiddleware({ runLimit: maxIterations, exitBehavior: "error" })`, and `stream` with `streamMode: "values"`, mapping failures to `RunResult` per contracts/reasoning-strategy.md

**Checkpoint**: User Stories 1 and 2 pass with a fake model

---

## Phase 5: User Story 3 - Answer a request with the Plan-and-Execute strategy (Priority: P3)

**Goal**: Planner, executor, and replanner graph with an 8-step cap

**Independent Test**: With a fake model, a run records a plan first, then one action and observation
per step, and ends when no steps remain

### Tests for User Story 3

- [X] T022 [US3] Write strategy tests in src/agents/plan-and-execute.test.ts with a fake model: plan before steps, replanner ends the run, replanner changes add a `plan` event, an empty plan ends with an answer and no steps, the cap of `min(maxIterations, 8)` gives `iteration_limit`, and a model failure keeps the partial trace

### Implementation for User Story 3

- [X] T023 [US3] Implement `createPlanExecuteStrategy({ model, tools })` named `plan-execute` as a `StateGraph` in src/agents/plan-and-execute.ts: planner with `withStructuredOutput(schema, { method: "functionCalling" })`, executor with one model turn per step, replanner that revises the remainder, and an explicit step counter

**Checkpoint**: All strategies pass with a fake model

---

## Phase 6: User Story 4 - Compare strategies in the arena (Priority: P4)

**Goal**: One command that runs strategies side by side

**Independent Test**: Invalid flags exit with code `2` without a provider, and a run with no provider
settings names the missing setting and exits with code `1`

### Tests for User Story 4

- [X] T024 [US4] Write flag parsing tests in src/arena.test.ts: defaults, `--input`, `--strategies`, `--max-iterations`, unknown strategy, and invalid limit

### Implementation for User Story 4

- [X] T025 [US4] Implement src/arena.ts per contracts/arena-cli.md: pure flag parsing with zod, a freshly seeded store per strategy, one strategy failing without stopping the rest, printed results, and exit codes `0`, `1`, and `2`

**Checkpoint**: Arena behaves as in contracts/arena-cli.md

---

## Phase 7: Polish

**Purpose**: Final checks

- [X] T026 [P] Update README.md: add `npm run seed`, and remove the note that scripts do not load `.env` for `arena`
- [X] T027 Run `npm run typecheck` and `npm test`, and fix any failure
- [X] T028 Run `npm run seed` and report its output, as the user requested
- [X] T029 Run the "Without a provider" section of specs/001-reasoning-nucleus/quickstart.md
- [X] T030 Report that the "With OpenRouter" section of specs/001-reasoning-nucleus/quickstart.md stays pending until credentials exist

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: No dependencies
- **Foundational**: Needs Setup, and blocks all stories
- **User Stories**: Run in priority order
- **Polish**: Needs all stories

### User Story Dependencies

- **US1**: Needs Foundational only
- **US2**: Needs US1 tools
- **US3**: Needs US1 tools, plus T017 to T020 from US2
- **US4**: Needs US2 and US3 strategies

### Within Each User Story

- Tests come first and must fail before implementation
- Pure functions before stateful wrappers
- Run `npm run typecheck` and `npm test` at each checkpoint

### Parallel Opportunities

- T003 and T004
- T006, T007, and T008
- T012 to T015, then T017 to T020

---

## Parallel Example: User Story 2

```text
T012 src/trace/from-messages.test.ts
T013 src/trace/format.test.ts
T014 src/agents/llm-counter.test.ts
T015 src/agents/model.test.ts
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational
2. Complete US1
3. Validate with `npm run seed` and `npm test`

### Incremental Delivery

Add US2, US3, and US4 in order, validating each at its checkpoint. Each task group fits one commit.
Live provider checks wait for the OpenRouter class.
