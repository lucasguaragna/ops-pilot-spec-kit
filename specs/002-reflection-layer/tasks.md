---

description: "Task list for the Reflection Layer"
---

# Tasks: Reflection Layer

**Input**: Design documents from `specs/002-reflection-layer/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/reflection.md, quickstart.md

**Tests**: Required. FR-012 asks for deterministic tests of the reflection loop with a fake model and
no network. Tests use `ScriptedChatModel` and `textTurn` from `src/testing/scripted-chat-model.ts`
and fake `ReasoningStrategy` objects that return scripted `RunResult` values.

**Organization**: Tasks are grouped by user story so each story can be built and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Phase 1: Setup

**Purpose**: Confirm a green baseline. No new dependencies are needed.

- [X] T001 Run `npm run typecheck` and `npm test` from the repository root and confirm both pass before any change

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Widen the critique event and share the structured-output retry helper. Every story
depends on these.

- [X] T002 Change the `critique` variant of `TraceEvent` in src/domain/types.ts to `{ type: "critique"; approved: boolean; fix?: "rerun" | "rewrite"; content: string }`; `content` holds the feedback
- [X] T003 [P] Add tests in src/trace/format.test.ts: an approved critique prints `[critique] approved: <feedback>`, and a rejected one prints `[critique] rejected (rerun): <feedback>` or `[critique] rejected (rewrite): <feedback>`
- [X] T004 Split `critique` out of the shared `thought`/`answer` case in `formatEvent` in src/trace/format.ts so it prints the formats tested in T003 (depends on T002)
- [X] T005 [P] Create src/agents/structured-output.ts exporting `STRUCTURED_ATTEMPTS = 2` and a pure-signature helper `structured<T>(role, schema, call)` moved from the inner `structured` function in src/agents/plan-and-execute.ts; it keeps the same behavior: call up to 2 times, `safeParse` the `parsed` field, return the first valid value, and otherwise throw `The ${role} returned no structured output after 2 attempts`
- [X] T006 Replace the local `STRUCTURED_ATTEMPTS` and `structured` in src/agents/plan-and-execute.ts with the import from src/agents/structured-output.ts; existing tests in src/agents/plan-and-execute.test.ts must pass unchanged (depends on T005)

**Checkpoint**: `npm run typecheck` and `npm test` pass. Nothing emits critique events yet.

---

## Phase 3: User Story 1 - Catch an answer the trace does not support (Priority: P1) MVP

**Goal**: A reflected strategy runs the base strategy once, asks the critic for a verdict, and adds
one `critique` event. With `maxReflections: 0` it never regenerates, so this story works on its own.

**Independent Test**: Wrap a fake strategy whose answer contradicts its observations, use
`maxReflections: 0`, and check the trace ends with a rejecting critique, the answer is kept, and
`llmCalls` is the base calls plus 1.

### Tests for User Story 1

> Write these first and confirm they fail before implementing.

- [X] T007 [P] [US1] In src/agents/reflection.test.ts, test `verdictSchema`: accepts `{ approved: true, feedback: "" }`; accepts `{ approved: false, feedback: "x", fix: "rerun" }`; rejects `{ approved: false, feedback: "x" }` because "`fix` Required when `approved` is false"; rejects a `fix` outside `"rerun" | "rewrite"`
- [X] T008 [P] [US1] In src/agents/reflection.test.ts, test `collectObservations(trace)`: returns only `observation` events, in order, across several attempts
- [X] T009 [P] [US1] In src/agents/reflection.test.ts, test `withReflection` creation: name is `reflect:<base name>`; `maxReflections` defaults to `2`; values that are not an integer `>= 0` (for example `-1` or `1.5`) throw when the decorator is created
- [X] T010 [US1] In src/agents/reflection.test.ts, test the run with `maxReflections: 0`: approved verdict gives the base trace plus `{ type: "critique", approved: true, content }`, the base answer, stop reason `completed`, and `llmCalls` equal to base calls plus 1; rejected verdict keeps the base answer and `completed`, with `approved: false` and its `fix` in the event
- [X] T011 [US1] In src/agents/reflection.test.ts, test edge cases: a base attempt that stops with `iteration_limit` or `error` is returned with no critique and no critic call; a critic that returns no valid verdict twice keeps the base answer with stop reason `completed` and a skipped-reflection `thought`; the critic call count (including the retry) is in `llmCalls`

### Implementation for User Story 1

- [X] T012 [US1] In src/agents/reflection.ts, export `verdictSchema` (zod): `approved` boolean, required; `feedback` string, required, "may be empty when approved"; `fix` `"rerun" | "rewrite"`, "Required when `approved` is false; ignored when true" (use `.refine`); export `type Verdict`
- [X] T013 [US1] In src/agents/reflection.ts, export pure helpers `collectObservations(trace)` and `toCritique(verdict): TraceEvent` (drops `fix` when approved), plus a pure `criticMessages(request, answer, observations)` that builds the system prompt and the user message; the prompt tells the critic to approve only when every claim in the answer is backed by an observation, and to choose `rewrite` when the actions were right but the answer misstates them, `rerun` when actions are missing or wrong
- [X] T014 [US1] In src/agents/reflection.ts, export `ReflectionOptions { model; maxReflections?: number }` and `withReflection(strategy, options)`: validate `maxReflections` (integer `>= 0`, default `2`) with zod at creation; `run` measures latency around the whole run, runs the base, returns early when the attempt is not `completed`, calls the critic through `structured("critic", verdictSchema, ...)` from src/agents/structured-output.ts with `withStructuredOutput(verdictSchema, { name: "verdict", method: "functionCalling", includeRaw: true })`, counts critic calls with `LlmCallCounter` from src/agents/llm-counter.ts, and never rejects (critic and rewrite failures keep the last answer, see research.md "Critic failure")

**Checkpoint**: US1 tests pass. A reflected strategy critiques once and reports summed metrics.

---

## Phase 4: User Story 2 - Regenerate a rejected answer with the feedback (Priority: P2)

**Goal**: A rejection leads to a rerun of the base strategy or a tool-free rewrite, as the verdict's
`fix` says, until approval or `maxReflections` regenerations.

**Independent Test**: With a fake strategy and a scripted critic that rejects once and then approves,
check the trace has two attempts and two critiques, the final answer is the second one, and
`llmCalls` sums every call.

### Tests for User Story 2

- [X] T015 [P] [US2] In src/agents/reflection.test.ts, test pure `nextStep(verdict, regenerations, maxReflections)`: returns `"stop"` when approved or when `regenerations === maxReflections`, otherwise the verdict's `fix`
- [X] T016 [P] [US2] In src/agents/reflection.test.ts, test pure `rerunInput(request, feedback, trace)`: contains the original request, the feedback, each earlier `action` with its tool, arguments, and matching observation, and the instruction not to repeat those actions
- [X] T017 [US2] In src/agents/reflection.test.ts, test a rerun loop: critic rejects with `fix: "rerun"` then approves; the base strategy receives the `rerunInput` text the second time; trace order is attempt 1, critique, attempt 2, critique; `llmCalls` is both attempts plus 2 critic calls
- [X] T018 [US2] In src/agents/reflection.test.ts, test a rewrite loop: critic rejects with `fix: "rewrite"`, the model returns a plain text turn, then the critic approves; the base strategy runs once; the trace adds one `answer` event with the rewritten text; `llmCalls` counts the rewrite call
- [X] T019 [US2] In src/agents/reflection.test.ts, test the limit: a critic that always rejects with the default limit gives at most 3 attempts and 3 critiques, stop reason `completed`, and the last attempt's answer
- [X] T020 [US2] In src/agents/reflection.test.ts, test that a rerun ending in `iteration_limit` or `error` stops the loop and returns that stop reason with the trace so far and summed metrics

### Implementation for User Story 2

- [X] T021 [US2] In src/agents/reflection.ts, export pure `nextStep(verdict, regenerations, maxReflections): "stop" | "rerun" | "rewrite"`
- [X] T022 [US2] In src/agents/reflection.ts, export pure `rerunInput(request, feedback, trace): string`, pairing each `action` with the next `observation` of the same tool
- [X] T023 [US2] In src/agents/reflection.ts, add the rewrite call: one `model.invoke` with no tools, a system prompt that asks for a corrected answer stating only what the observations show, and a user message with the request, the observations, the rejected answer, and the feedback; the reply text becomes an `answer` event and the new answer
- [X] T024 [US2] In src/agents/reflection.ts, turn the single critique of T014 into the loop from data-model.md: after each critique, call `nextStep`; on `"rerun"` run the base with `rerunInput`, on `"rewrite"` call the rewrite; join traces in order and add each attempt's `metrics.llmCalls` to the counter total

**Checkpoint**: US1 and US2 tests pass. The decorator meets FR-006 to FR-010.

---

## Phase 5: User Story 3 - Compare reflected strategies in the arena (Priority: P3)

**Goal**: `npm run arena -- --strategies react,reflect:react` runs both and prints critiques.

**Independent Test**: `parseArenaArgs` accepts `reflect:react` and `reflect:plan-execute`, and
`--strategies reflect:unknown` fails with a message that lists every known name.

### Tests for User Story 3

- [X] T025 [P] [US3] In src/arena.test.ts, test that `--strategies react,reflect:react,reflect:plan-execute` parses, and that `reflect:unknown` is rejected with a message that lists `reflect:react` and `reflect:plan-execute`

### Implementation for User Story 3

- [X] T026 [US3] In src/arena.ts, add `"reflect:react"` and `"reflect:plan-execute"` to `strategyFactories`, each building the base with the same dependencies and wrapping it with `withReflection(base, { model: dependencies.model })`; no new CLI flag

**Checkpoint**: All three stories work. The arena compares strategies with and without reflection.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T027 [P] Update README.md: add `reflect:react` and `reflect:plan-execute` to the strategy list and an arena example comparing `react,reflect:react`
- [X] T028 [P] Update specs/001-reasoning-nucleus/contracts/reasoning-strategy.md so the critique event row matches the new shape and links to specs/002-reflection-layer/contracts/reflection.md
- [X] T029 Run `npm run typecheck` and `npm test`; both must pass with network access off
- [X] T030 Run the quickstart.md "Without a provider" steps, then the "With OpenRouter" steps after `npm run seed`, and record any live-run surprises in specs/002-reflection-layer/research.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup; blocks every story
- **US1 (Phase 3)**: Depends on Foundational
- **US2 (Phase 4)**: Depends on US1, since it extends the same `withReflection` loop in src/agents/reflection.ts
- **US3 (Phase 5)**: Depends on US1 only; it can ship before US2 and then gains regeneration for free
- **Polish (Phase 6)**: Depends on every story being done

### Within Each Story

- Tests are written first and fail before the implementation
- Pure helpers come before the loop that uses them
- All US1 and US2 tasks touch src/agents/reflection.ts or its test, so they run one at a time except
  where marked [P] for separate test blocks

### Parallel Opportunities

- T003 and T005 touch different files and run in parallel
- T007, T008, and T009 are separate test blocks and can be drafted together
- T015 and T016 can be drafted together
- T025 can start as soon as US1 is done, in parallel with US2
- T027 and T028 run in parallel

## Parallel Example: Foundational

```text
Task: "Add critique format tests in src/trace/format.test.ts"            (T003)
Task: "Create src/agents/structured-output.ts with the retry helper"      (T005)
```

## Parallel Example: User Story 2 and User Story 3

```text
Task: "Test nextStep and rerunInput in src/agents/reflection.test.ts"     (T015, T016)
Task: "Test reflect:* names in src/arena.test.ts"                         (T025)
```

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 and Phase 2
2. Phase 3 (US1): the critic judges once and the trace shows the verdict
3. Stop and validate with `maxReflections: 0` in tests

### Incremental Delivery

1. Foundation, then US1: hallucinated answers are flagged
2. US3: compare `react` and `reflect:react` in the arena (critique only, if US2 is not done yet)
3. US2: rejected answers are regenerated by rerun or rewrite
4. Polish: docs and live validation
