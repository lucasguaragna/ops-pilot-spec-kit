# Implementation Plan: Learning Reflector

**Branch**: `009-learning-reflector` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-learning-reflector/spec.md`

## Summary

After `runChat` saves a completed exchange for a request with a `userId`, it starts a learning step
and returns without awaiting it. The step sends only the engineer's message to the request's chat
model, bound with `withStructuredOutput(learningVerdictSchema, { method: "functionCalling",
includeRaw: true })` and retried through the existing `structured()` helper. A pure `factToSave`
function turns the verdict into "save this fact" or "skip (no learning, invalid fact, or secret)";
the secret check is a pure `looksLikeSecret` over the proposed fact. A saved fact goes through
`memories.remember`, so the 0.92 dedup applies. The step runs under `runWithTimeout` (30 s, the
signal aborts the model call), never rejects, and logs its outcome. A `BackgroundTasks` tracker in
the settings holds the pending promise, so tests can await it with `settled()`. A new store method
`forgetClosest(userId, description)` removes the single closest memory scoring at least 0.5, and a
third memory tool, `forget_preference`, calls it. The HTTP reply shape does not change.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer

**Primary Dependencies**: Express 5, zod 4, LangChain/LangGraph, `@huggingface/transformers`
(all unchanged). No new dependency

**Storage**: SQLite `memories` table from feature 008, unchanged. One new prepared statement use
(the existing `deleteOne`), no DDL change

**Testing**: `node:test` via `tsx`; `ScriptedChatModel` with a `record_learning` tool-call turn;
`FakeEmbedder`, `FakeMemoryStore`; `BackgroundTasks.settled()` to await the step; a gated memory
store to hold the step open; `mock.method(console, ...)` to check logs

**Target Platform**: Local Node.js HTTP service (127.0.0.1 by default)

**Project Type**: Web service (single project)

**Performance Goals**: Zero added reply latency (the step starts after the reply is decided). One
extra model call per completed request with a `userId` (up to 5 on structured-output misses), plus
one local embedding when a fact is saved

**Constraints**: The step reads only the last message; never blocks or changes the reply, the
metrics, or the history; never rejects; bounded at 30 s; one fact per message; no secret stored
even if the model proposes one; prepared statements only; the MCP server, arena, and bench stay
unchanged; `ReasoningStrategy`, `Metrics`, and the chat API schemas stay unchanged

**Scale/Scope**: Same as 008: tens to hundreds of facts per user, single-digit concurrent users,
one process

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / rule | How the plan complies | Status |
| --- | --- | --- |
| I. Layered MVC | Controller unchanged → Service `chat-service` starts the step → `learning-reflector` (agents) calls the model and the `MemoryStore` interface (Model). `forget_preference` calls only the store interface. | Pass |
| II. Validated boundaries | The model's verdict is a boundary: parsed by `learningVerdictSchema`, then the fact by `MemoryFact`. `ForgetPreferenceInput` is a zod schema. HTTP schemas unchanged. | Pass |
| III. Domain errors at the edge | No new error class. A no-match in `forget_preference` is a normal result, not an error. Step failures are caught and logged in the service; they never reach a client. | Pass |
| IV. Pure functions | `looksLikeSecret`, `factToSave`, `shouldLearn`, `learningLogLine`, `findClosest`, `learningMessages` are pure. The model call, embedding, and SQL stay in the reflector's `learn` and the store. | Pass |
| V. Tested and green | Pure-function tests (secret patterns, every skip reason, the 0.5 boundary), reflector tests with a scripted model, contract tests for `forgetClosest` on both stores, tool tests, service tests for detach, gating, timeout, and failure logging. | Pass |
| Persistence: path from `OPSPILOT_DB` | Unchanged. | Pass |
| Persistence: tests use `":memory:"` | All new store tests run in the shared contract suite on `":memory:"`. | Pass |
| Persistence: prepared statements | `forgetClosest` reuses `selectByUser` and `deleteOne`. | Pass |
| Persistence: idempotent schema | No schema change. | Pass |
| Persistence: CHECK on closed fields | No new column. | Pass |
| Persistence: in-memory only in tests | `FakeMemoryStore` gains `forgetClosest` and stays in `src/testing/`. `BackgroundTasks` is production code, not a test double. | Pass |
| Persistence: no SQL outside the Model | The tool sees only `MemoryStore`. | Pass |
| No stack change | No new dependency. | Pass |
| Secrets | `looksLikeSecret` rejects credential-like facts before `remember`; the log never prints a rejected fact. | Pass |

Post-design re-check: still all Pass.

## Project Structure

### Documentation (this feature)

```text
specs/009-learning-reflector/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── learning-reflector.md
│   ├── memory-store.md
│   └── memory-tools.md
├── checklists/requirements.md
└── tasks.md             # created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   └── schemas.ts                    # + ForgetPreferenceInput
├── memory/
│   ├── memory-store.ts               # + FORGET_MIN_SCORE, findClosest, MemoryStore.forgetClosest, SQLite impl
│   ├── memory-store-contract.ts      # + forgetClosest cases (0.5 boundary, tie, per-user, none)
│   └── memory-store.test.ts          # + findClosest pure tests
├── agents/
│   ├── learning-reflector.ts         # NEW: schema, prompt, looksLikeSecret, factToSave, learningMessages, createLearningReflector
│   ├── learning-reflector.test.ts    # NEW
│   ├── memory-tools.ts               # + forget_preference (third tool)
│   └── memory-tools.test.ts          # + forget_preference cases; tool order updated
├── tools/
│   └── memory-definitions.ts         # + forgetPreferenceDefinition
├── http/
│   ├── background-tasks.ts           # NEW: BackgroundTasks { track, settled }
│   ├── background-tasks.test.ts      # NEW
│   ├── chat-reply.ts                 # + shouldLearn(userId, outcome), learningLogLine(userId, timed) (pure)
│   ├── chat-reply.test.ts            # + shouldLearn and learningLogLine cases
│   ├── chat-service.ts               # start the step after saving; logLearning
│   ├── chat-service.test.ts          # + detach, gate, timeout, failure, no-userId, non-completed
│   ├── server.ts                     # AppSettings.background (default new BackgroundTasks()), learningTimeoutMs (default LEARNING_TIMEOUT_MS = 30_000)
│   └── server.test.ts                # existing userId cases script a no-learning turn
└── testing/
    ├── fake-memory-store.ts          # + forgetClosest
    ├── learning-turns.ts             # NEW: learningTurn(verdict), NO_LEARNING for scripted models
    ├── scripted-chat-model.ts        # + hangingTurn(): pending until the call's signal aborts
    └── scripted-chat-model.test.ts   # NEW: hangingTurn cases
```

**Structure Decision**: Single project, following 008. The reflector goes in `src/agents/` beside
`reflection.ts`, because it is a model call shaped like the critic. `BackgroundTasks` goes in
`src/http/` because the service owns the request lifecycle. `runWithTimeout` stays in
`chat-service.ts`; the reflector takes a signal, so the agents layer never imports from `http/`.

## Implementation Notes

- **Order inside `runChat`** (research R1, R7): unchanged up to the save, then
  `if (shouldLearn(userId, outcome)) settings.background.track(learnInBackground(...))`, then
  return. No `await` on the step. `learnInBackground` = `runWithTimeout((signal) =>
  reflector.learn(userId, message, signal), settings.learningTimeoutMs).then((timed) =>
  logLearning(userId, timed, settings.learningTimeoutMs))`; it
  cannot reject.
- **Reflector model**: `createLearningReflector({ model: dependencies.model, memories })`, built per
  request from the same dependencies the agent got. Its calls do not use the run's `LlmCallCounter`,
  so `metrics.llmCalls` is unchanged (FR-007).
- **Scripted tests**: the reflector's call comes after every agent call, so a test appends one
  `learningTurn(...)` to the script. A test whose script lacks it still passes, but logs a failure
  after 5 attempts; existing tests with a `userId` get a no-learning turn to stay quiet.
- **Atomic forget**: `forgetClosest` awaits the embedding first, then scans and deletes with no
  `await` between them, like `remember` (research R6).
- **Learn-by-doing candidate**: `looksLikeSecret` in `src/agents/learning-reflector.ts`. It is a few
  regular expressions that hold the feature's security trade-off: what counts as a credential, and
  how many harmless facts it may reject.
- **Docs**: the README "Semantic memory" section gains a short "Learning" paragraph (what is
  learned, what never is, `forget_preference`, the log lines). `CLAUDE.md`, `docs/openapi.yaml`,
  and `docs/insomnia.json` need no change: the HTTP contract is the same.

## Complexity Tracking

No violations.
