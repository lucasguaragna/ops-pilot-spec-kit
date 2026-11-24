---

description: "Task list for feature 009: Learning Reflector"
---

# Tasks: Learning Reflector

**Input**: Design documents from `specs/009-learning-reflector/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. FR-014 asks for tests that drive the model's structured answer and await the
step, SC-001 to SC-005 are each verified by an automated test, and the constitution requires new
logic to ship with a test. Within each story, write the tests first and see them fail before you
implement.

**Organization**: Tasks are grouped by user story, so each story can be built and tested on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1 to US3)
- Paths are relative to the repository root

---

## Phase 1: Setup

**Purpose**: A green baseline. No new dependency.

- [X] T001 Run `npm run typecheck` and `npm test` at the repository root and confirm both pass before any change, so later failures can be traced to this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The background tracker, the reflector's types, the test helpers, and the two new
settings. Every story that runs the learning step depends on them.

- [X] T002 [P] Write `src/http/background-tasks.test.ts` for `BackgroundTasks` (data-model "Background task"): `settled()` resolves at once with nothing tracked; `pending` counts tracked tasks and drops back to 0 when each one resolves and when each one rejects; `settled()` waits for a task that resolves later; `settled()` also waits for a task tracked while it was already waiting; a rejecting task never makes `settled()` reject. Use promises you resolve by hand, never `setTimeout`.
- [X] T003 Implement `BackgroundTasks` in `src/http/background-tasks.ts`: `track(task: Promise<unknown>): void` adds the task to a `Set` and removes it in a `.then(remove, remove)` that swallows the rejection; `get pending(): number`; `settled(): Promise<void>` loops `while (set.size > 0) await Promise.allSettled([...set])`. Make T002 pass.
- [X] T004 [P] Create `src/agents/learning-reflector.ts` with only the types and constants from [contracts/learning-reflector.md](contracts/learning-reflector.md): `LEARNING_TOOL_NAME = "record_learning"`, `learningVerdictSchema = z.object({ hasLearning: z.boolean(), fact: z.string() })` with `.describe(...)` text on both fields (`fact` is required and "may be empty when `hasLearning` is false", as the critic's `feedback`), `LearningVerdict`, `LearningSkipReason = "no_learning" | "invalid_fact" | "secret"`, `LearningDecision`, `LearningOutcome` (`saved` and `duplicate` carry `memory: Memory`, `skipped` carries `reason`), and the `LearningReflector` interface. No logic yet.
- [X] T005 Create `src/testing/learning-turns.ts` (after T004): `learningTurn(verdict: LearningVerdict): AIMessage`, which is `toolCallTurn(LEARNING_TOOL_NAME, verdict)`, and `NO_LEARNING = learningTurn({ hasLearning: false, fact: "" })`
- [X] T006 [P] Write `src/testing/scripted-chat-model.test.ts` for a new `hangingTurn()` (research R9): a model whose turn is `hangingTurn()` stays pending until the call's `signal` aborts, then rejects with an abort error; `calls` counts that call; a normal `textTurn` after it in the script is still served on the next call.
- [X] T007 Extend `src/testing/scripted-chat-model.ts` (after T006): add a `HANG` marker to `ScriptedTurn` and export `hangingTurn()`. In `_generate(messages, options)`, a `HANG` turn returns a promise that rejects with `options.signal.reason` when the signal aborts (reject at once if it is already aborted). The other turns behave as before. Make T006 pass.
- [X] T008 Add two optional settings to `AppSettings` in `src/http/server.ts` (after T003): `background?: BackgroundTasks` and `learningTimeoutMs?: number`. Export `LEARNING_TIMEOUT_MS = 30_000`. `resolveSettings` fills in `new BackgroundTasks()` and `LEARNING_TIMEOUT_MS`. `src/index.ts` needs no change, because both settings are optional.
- [X] T009 In the existing tests that send a `userId`, append `NO_LEARNING` after the agent's turns (after T005): `src/http/chat-service.test.ts` and `src/http/server.test.ts`. The extra turn is never consumed until US1 lands, so `npm test` stays green now. Afterwards it keeps those tests from logging a learning failure after 5 attempts. Pass a fresh `new BackgroundTasks()` in the settings of every such test, so later tasks can await it.

**Checkpoint**: `npm run typecheck` and `npm test` are green. Nothing calls the reflector yet.

---

## Phase 3: User Story 1 - The copilot learns lasting facts without being told to remember them (Priority: P1) 🎯 MVP

**Goal**: After a completed run with a `userId`, a background step asks the model for a
`{ hasLearning, fact }` verdict on the engineer's last message and saves a valid fact through
`memories.remember`. The reply never waits for it.

**Independent Test**: Run `runChat` with a `userId` and a scripted `learningTurn({ hasLearning:
true, fact: "The engineer is on the payments team" })`, `await background.settled()`, and check that
the user has that one memory and the reply is the same as without the feature.

### Tests for User Story 1 (write first, see them fail)

- [X] T010 [P] [US1] Add pure tests to a new `src/agents/learning-reflector.test.ts`:
  - `learningMessages("hi")` returns exactly two messages: a system message, then a human message whose content is `The engineer's message:\nhi`. The system message states rules 1 to 6 of [contracts/learning-reflector.md](contracts/learning-reflector.md). Assert that the key phrases are present: lasting fact, never a request or question, never a credential, at most one fact, one short English sentence about "the engineer", and `hasLearning: false` with an empty `fact`.
  - `factToSave` returns `{ kind: "skip", reason: "no_learning" }` for `hasLearning: false`, even when `fact` holds text.
  - It returns `{ kind: "skip", reason: "invalid_fact" }` for `hasLearning: true` with `""`, with `"   "`, and with a fact of 501 characters after trimming. The rule is "non-empty after trimming, at most 500 characters", checked with `MemoryFact`.
  - It returns `{ kind: "save", fact: "The engineer owns checkout" }` for `"  The engineer owns checkout  "`, trimmed, and it accepts a fact of exactly 500 characters.
- [X] T011 [US1] Add reflector tests to `src/agents/learning-reflector.test.ts` (after T010). Build the reflector with `ScriptedChatModel`, `FakeEmbedder`, and `FakeMemoryStore`:
  - A `learningTurn` with a valid fact resolves to `{ kind: "saved", memory }`, and the user now has that memory.
  - A fact scoring above 0.92 against one the user already has resolves to `{ kind: "duplicate", memory }` with the existing memory, and stores nothing new.
  - `NO_LEARNING` resolves to `skipped: no_learning` and never calls the embedder (`embedder.calls` is empty).
  - The model is called once, with exactly `learningMessages(message)` and no history.
  - A model that returns text 5 times rejects, and nothing is stored (it goes through `structured()`, `STRUCTURED_ATTEMPTS`).
  - A `hangingTurn()` with a signal aborted mid-call rejects, and nothing is stored.
  - A signal aborted after the model answered rejects without calling `remember`. Abort the controller from a callback handler set on the scripted model's `callbacks` field, `{ handleLLMEnd: () => controller.abort() }`, which fires after the model produced its answer. Spy on `remember` with `mock.method(memories, "remember")` and assert 0 calls. The rejection may come from LangChain's own signal check in the structured-output chain or from `signal.throwIfAborted()`; either way nothing is written. Do not abort from inside `remember`: by then the write has already started.
- [X] T012 [P] [US1] Add tests to `src/http/chat-reply.test.ts`:
  - `shouldLearn(userId, outcome)` is true only for a defined `userId` together with `{ kind: "result" }` whose `stopReason` is `"completed"`.
  - It is false with no `userId`, for `stopReason: "iteration_limit"`, for `{ kind: "thrown" }`, and for `{ kind: "timeout" }`.
  - `learningLogLine(userId, timed, timeoutMs)` follows the log table of [contracts/learning-reflector.md](contracts/learning-reflector.md) row for row:
    - `saved` gives `{ stream: "log", line: "Learned [memory 7] for u1" }`.
    - `duplicate` gives `Learning already known as [memory 7] for u1`.
    - `skipped: secret` and `skipped: invalid_fact` give `stream: "warn"`.
    - `skipped: no_learning` gives `undefined`.
    - `thrown` gives `stream: "error"` with `Learning failed for u1: Error: provider down`.
    - `timeout` with `timeoutMs` 30000 gives `Learning timed out after 30000 ms for u1`, and with `timeoutMs` 1 gives `after 1 ms`.
    - No line contains the fact text.
- [X] T013 [P] [US1] Add service tests to `src/http/chat-service.test.ts`. Each passes its own `BackgroundTasks` and stubs `console.log`/`warn`/`error` with `mock.method`, restored after each test:
  - **(a)** A `userId` request whose script ends with a `learningTurn` saves the fact after `await background.settled()` and logs `Learned [memory 1] for <userId>`.
  - **(b) SC-001:** a second `runChat` with the same `userId` and no `conversationId` reports `recalledMemories: 1`, and the agent's input holds the fact.
  - **(c) SC-003:** use a `FakeMemoryStore` subclass whose `remember` awaits a hand-opened gate. Subclass it, do not wrap it, so the class keeps up when `MemoryStore` gains `forgetClosest` in US3.
    - `runChat` resolves while `background.pending === 1` and the fact is not stored yet.
    - Open the gate and `await settled()`. The fact is stored.
  - **(d) FR-007:** the outcome's `result` and metrics (including `llmCalls`) deep-equal those of the same request scripted with `NO_LEARNING`.
  - **(e)** With no `userId`, `background.pending` is 0 after `runChat` and the model was called only for the agent's turns.
  - **(f)** A run that hits the iteration limit, a run that throws, and a run that times out each leave `background.pending` at 0.
  - **(g) FR-008:** a learning turn that is an `Error`, repeated 5 times, logs `Learning failed for ...` on `console.error`, stores nothing, and leaves the returned outcome unchanged.
  - **(h)** A `hangingTurn()` with `learningTimeoutMs: 1` logs `Learning timed out after 1 ms for ...` and stores nothing.
- [X] T014 [P] [US1] Add one case to `src/http/server.test.ts`. `POST /chat` with a `userId` and a script ending in a `learningTurn` returns 200 with the same body shape as before (SC-006). After `await background.settled()`, the memory store holds the fact.

### Implementation for User Story 1

- [X] T015 [US1] In `src/agents/learning-reflector.ts`, implement two pure functions:
  - `learningMessages(message)`: a `SystemMessage` with prompt rules 1 to 6 of [contracts/learning-reflector.md](contracts/learning-reflector.md) and research R3, then a `HumanMessage` of `The engineer's message:\n${message}`.
  - `factToSave(verdict)`: first `no_learning`, then `invalid_fact` when `MemoryFact.safeParse(verdict.fact)` fails, then `{ kind: "save", fact }` with the parsed, trimmed fact. Leave a comment where the secret check goes; it lands in US2 (T024).

  Make T010 pass.
- [X] T016 [US1] Implement `createLearningReflector({ model, memories })` in `src/agents/learning-reflector.ts` (after T015). Its `learn(userId, message, signal)` works as follows:
  - Bind `model.withStructuredOutput(learningVerdictSchema, { name: LEARNING_TOOL_NAME, method: "functionCalling", includeRaw: true })` once.
  - Get the verdict with `structured("learning reflector", learningVerdictSchema, () => bound.invoke(learningMessages(message), { signal }))`, the same pattern as `src/agents/reflection.ts`.
  - On skip, return `{ kind: "skipped", reason }`.
  - On save, call `signal.throwIfAborted()`, then `memories.remember(userId, fact)`. Map `created` to `saved` and `!created` to `duplicate`.
  - Do not import anything from `src/http/`.

  Make T011 pass.
- [X] T017 [P] [US1] Implement two pure functions in `src/http/chat-reply.ts`, next to `messagesToSave`:
  - `shouldLearn(userId: string | undefined, outcome: RunOutcome): boolean`.
  - `learningLogLine(userId, timed: TimedRun<LearningOutcome>, timeoutMs: number): { stream: "log" | "warn" | "error"; line: string } | undefined`, following the log table. `timeoutMs` is a parameter because the `timeout` case of `TimedRun` carries no duration. The error name and message come from the thrown value; use `String(error)` when it is not an `Error`. It never prints `verdict.fact`.

  Make T012 pass.
- [X] T018 [US1] Wire the step into `runChat` in `src/http/chat-service.ts` (after T008, T016, T017). Add it after the `messagesToSave` loop and before `return`:
  - When `shouldLearn(userId, outcome)`, build `createLearningReflector({ model: dependencies.model, memories })`.
  - Call `settings.background.track(runWithTimeout((signal) => reflector.learn(userId, request.message, signal), settings.learningTimeoutMs).then((timed) => logLearning(userId, timed, settings.learningTimeoutMs)))`. Add no `await`.
  - `logLearning` writes `learningLogLine(userId, timed, timeoutMs)` to `console[stream]` and does nothing on `undefined`.
  - Update the `runChat` doc comment to say the learning step starts after the save and is never awaited.

  Make T013 and T014 pass.
- [X] T019 [US1] Run `npm run typecheck` and `npm test`. Both are green, and no test logs an unexpected `Learning failed` line.

**Checkpoint**: US1 works on its own. A lasting fact is learned in the background and recalled
later. The reply, history, and metrics are unchanged.

---

## Phase 4: User Story 2 - One-off requests and secrets are never learned (Priority: P1)

**Goal**: A deterministic `looksLikeSecret` check blocks any credential-like fact, whatever the
model answered. One-off requests produce no memory.

**Independent Test**: Run the reflector on one-off requests (`NO_LEARNING`), and on turns where the
model wrongly proposes a fact holding a password, token, or key. Check that no memory is stored and
that the fact never reaches the log.

### Tests for User Story 2 (write first, see them fail)

- [X] T020 [P] [US2] Add `looksLikeSecret` cases to `src/agents/learning-reflector.test.ts`, as two `for` tables (research R4).
  - **True:**
    - `"The staging DB password is hunter2"`, `"passwd: hunter2"`, `"api_key=abc123"`, `"The API key is abc123"`, `"token: xyz789"`.
    - `"Bearer abc.def"` and `"Authorization: Bearer abc123"`, the `bearer` exception of R4: the value follows whitespace alone.
    - `"-----BEGIN RSA PRIVATE KEY-----"`, `"-----BEGIN OPENSSH PRIVATE KEY-----"`.
    - `"postgres://admin:s3cret@db.internal:5432/app"`.
    - `"sk-" + "a1".repeat(12)`, `"ghp_" + "A1".repeat(18)`, `"github_pat_" + "A1".repeat(20)`, `"xoxb-1234-abcd"`, `"AKIA" + "ABCDEFGH12345678"`, and a 3-part JWT starting `eyJ`.
    - A 32-character run that mixes letters and digits, `"a1".repeat(16)`.
  - **False:**
    - `"The engineer owns the checkout alerts"`, `"The engineer rotates API keys monthly"`, and `"Tokens expire after one hour on the payments API"`, where the credential word has no value.
    - `"The payments API uses bearer authentication"`: `bearer` followed by a plain word with no digit or token punctuation.
    - `"The engineer prefers risk-based alerting"` and `"The checkout nodes are disk-heavy"`: `sk-` inside a word, not at its start.
    - `"https://grafana.internal/d/checkout"`, a URL without credentials.
    - A 32-letter run with no digit, `"a".repeat(32)`, and a 31-character mixed run.
  - Add `factToSave` cases:
    - A valid `hasLearning: true` fact that looks like a secret gives `{ kind: "skip", reason: "secret" }`.
    - A 501-character fact that holds a secret gives `invalid_fact`, because validation comes first.
- [X] T021 [US2] Add reflector cases to `src/agents/learning-reflector.test.ts` (after T020):
  - **SC-002:** a model proposing `{ hasLearning: true, fact: "The engineer's DB password is hunter2" }` resolves to `skipped: secret`, `embedder.calls` is empty, and the user has no memory.
  - **US2 scenario 3:** the message `"I own checkout; the DB password is hunter2"` with a model proposing `"The engineer owns checkout"` resolves to `saved`. The check runs on the fact, not the message.
  - Three one-off requests (`"Open an incident for checkout"`, `"Resolve INC-004"`, `"Which alerts are firing?"`) with `NO_LEARNING` each store nothing.
- [X] T022 [P] [US2] Add a case to `src/http/chat-service.test.ts`. A learning turn proposing a secret fact logs `Learning skipped for <userId>: secret` on `console.warn`. No argument of any `console.log`/`warn`/`error` call contains `hunter2`, and the store stays empty.

### Implementation for User Story 2

- [X] T023 [US2] In `src/agents/learning-reflector.ts`, add an exported `looksLikeSecret(text: string): boolean` with a doc comment listing the five pattern families of research R4. Leave the body as a single `TODO(human)` for the Learn-by-doing step (see Implementation Strategy), then fill it in from the engineer's code. Make the `looksLikeSecret` cases of T020 pass.
- [X] T024 [US2] In `factToSave` (after T023), add `{ kind: "skip", reason: "secret" }` between the `invalid_fact` check and the save, applied to the trimmed fact. Make T020 to T022 pass.
- [X] T025 [US2] Run `npm run typecheck` and `npm test`. Both are green.

**Checkpoint**: US1 and US2 work together. No credential-like fact is ever stored or logged.

---

## Phase 5: User Story 3 - The engineer can make the copilot forget a preference by describing it (Priority: P2)

**Goal**: A store method `forgetClosest(userId, description)` removes the single closest memory
scoring at least 0.5, and a third memory tool, `forget_preference`, exposes it to the agent.

**Independent Test**: Save a fact for a user and call `forget_preference` with a rewording whose
fake score is 0.5. The fact is removed and named. Call it again with a description scoring
0.4999: nothing is removed and the result is `{ forgotten: false }`.

### Tests for User Story 3 (write first, see them fail)

- [X] T026 [P] [US3] Add pure `findClosest(scored, minScore)` tests to `src/memory/memory-store.test.ts`:
  - It returns the memory scoring exactly 0.5 with `minScore` 0.5.
  - It returns `undefined` when the best score is 0.4999.
  - It returns the highest of several.
  - On a tie, it returns the newest, the one with the higher id.
  - It returns `undefined` for an empty list.
- [X] T027 [P] [US3] Add a `forgetClosest` block to `src/memory/memory-store-contract.ts`, so it runs on both `SqliteMemoryStore` (`":memory:"`) and `FakeMemoryStore`. Use `scoredAgainst` from `src/testing/fake-embedder.ts` for exact scores. It covers the 5 cases of [contracts/memory-store.md](contracts/memory-store.md) plus three more:
  1. A description scoring exactly 0.5 removes the fact and returns it without a score. One scoring 0.4999 returns `undefined` and removes nothing.
  2. With several facts at or above 0.5, only the closest is removed. On a tie, the newest is removed.
  3. Another user's identical fact is never removed.
  4. A user with no memories gets `undefined`.
  5. After removal, `recall` no longer returns the removed fact and still returns the others.
  6. A blank description and a 501-character description throw `ZodError`, removing nothing.
  7. An invalid `userId` throws `ZodError`.
  8. A failing embedder's `EmbeddingError` propagates.
- [X] T028 [P] [US3] Add tests to `src/agents/memory-tools.test.ts`:
  - `createMemoryTools(memories, "u1")` returns three tools in the order `remember_fact`, `forget_fact`, `forget_preference`. Update the existing two-tool assertion.
  - `forget_preference` with a matching description returns `{ id, fact, forgotten: true }` and removes the fact.
  - With no match, it returns `{ forgotten: false }` and removes nothing.
  - A blank description returns a tool error message and does not throw (FR-012).
  - A tool built for `u1` never removes `u2`'s identical fact (FR-010).
  - Its input schema has a `description` field and no user field.

### Implementation for User Story 3

- [X] T029 [P] [US3] Add `ForgetPreferenceInput = z.object({ description: MemoryFact })` and its type to `src/domain/schemas.ts`. Its limits are the `MemoryFact` limits: "trimmed, 1 to 500 characters".
- [X] T030 [US3] In `src/memory/memory-store.ts`:
  - Export `FORGET_MIN_SCORE = 0.5`.
  - Export `findClosest(scored, minScore) = rankMemories(scored, { limit: 1, minScore })[0]`.
  - Add `forgetClosest(userId: string, description: string): Promise<Memory | undefined>` to the `MemoryStore` interface, with the doc comment from the contract.
  - Implement it in `SqliteMemoryStore`. Parse `userId` with `UserId` and `description` with `MemoryFact`, then `await` the embedding. After that, with no `await` before the end, score the user's rows from the prepared `selectByUser`, pick `findClosest(..., FORGET_MIN_SCORE)`, and delete it with the prepared `deleteOne` by `id` and `user_id`.
  - Return the memory without its score.

  Make T026 pass.
- [X] T031 [US3] Add `forgetClosest` to `FakeMemoryStore` in `src/testing/fake-memory-store.ts`, in the same change as T030 so typecheck stays green. Use the same validation, `findClosest`, and threshold. Make T027 pass on both stores.
- [X] T032 [P] [US3] Add `forgetPreferenceDefinition` to `src/tools/memory-definitions.ts` (after T029), with the name `forget_preference`, the description draft from [contracts/memory-tools.md](contracts/memory-tools.md), and `ForgetPreferenceInput` as the schema
- [X] T033 [US3] Add the `forget_preference` tool to `createMemoryTools` in `src/agents/memory-tools.ts` (after T030 to T032). Make it the third tool, run it through `runToolTextAsync`, and call `memories.forgetClosest(userId, description)` with the captured `userId`. It returns `{ id, fact, forgotten: true }` or `{ forgotten: false }`. An `EmbeddingError` is not caught, so the run fails as in 008. Make T028 pass.
- [X] T034 [US3] Update any test in `src/http/chat-service.test.ts` or `src/http/server.test.ts` that asserts the list of memory tool names to include `forget_preference`. Then run `npm run typecheck` and `npm test`. Both are green.

**Checkpoint**: All three stories work. `remember_fact` and `forget_fact` are unchanged (FR-013).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T035 [P] In the "Semantic memory" section of `README.md`, add a short "Learning" paragraph covering:
  - The background step after a completed reply with a `userId`.
  - What is learned and what never is: one-off requests and secrets.
  - At most one fact per message.
  - The 30 s bound.
  - The `forget_preference` tool and its 0.5 threshold.
  - The log lines `Learned [memory N] for <userId>` and `Learning skipped for <userId>: secret`.
- [X] T036 [P] Confirm that these are unchanged and still compile, since the HTTP contract and the MCP server stay the same: `TOOL_DEFINITIONS`, the MCP server (`src/mcp/`), `src/arena.ts`, `src/bench.ts`, `docs/openapi.yaml`, `docs/insomnia.json`, and `CLAUDE.md`.
- [X] T037 Run `npm run typecheck` and `npm test` and confirm both are green. Confirm no test touched `OPSPILOT_DB` or `data/`.
- [ ] T038 Manual check, run by the engineer because it needs their own OpenRouter key: quickstart steps 1 to 6 against `OPSPILOT_DB=/tmp/opspilot-009.db`, then remove the scratch file

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: depends on Setup and blocks US1 and US2
- **US1 (Phase 3)**: depends on Foundational
- **US2 (Phase 4)**: depends on US1 (T015, the home of `factToSave`, and T018, for the service log test)
- **US3 (Phase 5)**: depends only on Setup. It touches neither the reflector nor `runChat`, so it can run alongside US1 and US2. The exception is T034, which comes after T009.
- **Polish (Phase 6)**: after every story you want to ship

### Within Phases

- In Phase 2:
  - T002 comes before T003.
  - T004 comes before T005.
  - T006 comes before T007.
  - T003 comes before T008.
  - T005 comes before T009.
- In US1, write the tests T010 to T014 first, and they should fail. Then implement in this order:
  1. T015, then T016.
  2. T017 alongside T015 and T016.
  3. T018 last.
- In US2, T020 comes before T021. T023 comes before T024.
- In US3:
  - T029 comes before T032.
  - T030 and T031 land in one change.
  - T030, T031, and T032 come before T033.

### Parallel Opportunities

- Phase 2: T002, T004, and T006 together
- US1 tests: T010, T012, T013, and T014 together (different files)
- US1 implementation: T017 alongside T015 and T016
- US2: T020 and T022 together
- US3 tests: T026 to T028 together. T029 runs alongside them.
- US3 as a whole can run while US1 or US2 is in progress
- Polish: T035 and T036 together

### Parallel Example: User Story 1

```text
Task: "T010 learningMessages / factToSave tests in src/agents/learning-reflector.test.ts"
Task: "T012 shouldLearn / learningLogLine tests in src/http/chat-reply.test.ts"
Task: "T013 detach, gate, timeout, and failure tests in src/http/chat-service.test.ts"
Task: "T014 POST /chat learning case in src/http/server.test.ts"
```

### Parallel Example: User Story 3

```text
Task: "T026 findClosest tests in src/memory/memory-store.test.ts"
Task: "T027 forgetClosest contract cases in src/memory/memory-store-contract.ts"
Task: "T028 forget_preference tests in src/agents/memory-tools.test.ts"
Task: "T029 ForgetPreferenceInput in src/domain/schemas.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1, then Phase 2
2. Phase 3 (US1): the background step learns and saves a fact, and the reply is untouched
3. **Stop and validate**: `npm test`. Then do quickstart steps 1 and 2 by hand. They are safe even
   before US2, because the model is told never to propose a credential.

### Incremental Delivery

1. US1: learn in the background (MVP)
2. US2: the deterministic secret guard, so the "never a secret" rule holds even when the model is
   wrong
3. US3: `forget_preference`
4. Polish: the docs and the final green run

US1 and US2 are both P1. Do not ship US1 to real users without US2: the model instruction alone is
not a guarantee.

### Learn by Doing

T023 leaves the body of `looksLikeSecret` in `src/agents/learning-reflector.ts` as the only
`TODO(human)`. T020 already pins its behaviour on both sides:

- The credential word must be followed by a value, so a word alone does not count. `bearer` takes
  its value after whitespace alone, and that value must look like a token.
- `sk-` counts only at the start of a word and with 20 or more characters after it.
- The opaque-run rule needs 32 or more characters that mix letters and digits.
- The URL rule needs both a user and a password.

The trade-off is how many harmless facts the check may reject. A UUID in a fact matches the
opaque-run rule, which the spec accepts as a false positive.

## Notes

- `[P]` means a different file with no dependency on an unfinished task.
- The reflector's model calls never use the run's `LlmCallCounter`, so `metrics.llmCalls` is
  unchanged.
- In a test with a `userId`, read `model.calls` only after `await background.settled()`, or script
  `NO_LEARNING`. Otherwise the count depends on whether the step has run yet.
- Every query uses a prepared statement. Tests use only `":memory:"` and never `OPSPILOT_DB` or
  `data/`.
- No test calls a real model. Only `src/memory/embeddings.test.ts` loads the real embedding model,
  unchanged from 008.
- Never read `.env`.
