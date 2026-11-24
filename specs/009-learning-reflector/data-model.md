# Data Model: Learning Reflector

No table changes. Learned facts are ordinary rows of the `memories` table from feature 008
([008 data model](../008-semantic-memory/data-model.md)). Everything below exists only in memory.

## Learning verdict (`learningVerdictSchema`, `src/agents/learning-reflector.ts`)

The model's structured answer for one message. Never stored.

| Field | Type | Rule |
| --- | --- | --- |
| `hasLearning` | boolean | true only when the message states a lasting fact |
| `fact` | string | the fact as one short English sentence; may be empty when `hasLearning` is false |

Parsed by zod. A missing or wrong-typed field counts as a structured-output miss and is retried
(up to 5 attempts), then the step fails.

## Learning decision (`factToSave(verdict)`, pure)

| Verdict | Decision |
| --- | --- |
| `hasLearning: false` (any `fact`) | `{ kind: "skip", reason: "no_learning" }` |
| `hasLearning: true`, `fact` fails `MemoryFact` (blank after trimming, or more than 500 characters) | `{ kind: "skip", reason: "invalid_fact" }` |
| `hasLearning: true`, valid `fact`, `looksLikeSecret(fact)` | `{ kind: "skip", reason: "secret" }` |
| otherwise | `{ kind: "save", fact }` (the trimmed fact) |

The order matters: validation comes before the secret check, so the check always sees trimmed
text of at most 500 characters.

## Learning outcome (`LearningOutcome`)

What `reflector.learn(userId, message, signal)` resolves to.

| Kind | Payload | When |
| --- | --- | --- |
| `saved` | `memory: Memory` | `remember` stored a new row |
| `duplicate` | `memory: Memory` (the existing one) | `remember` found a fact scoring above 0.92 |
| `skipped` | `reason: "no_learning" \| "invalid_fact" \| "secret"` | `factToSave` said skip; nothing was written |

A model failure, a structured-output miss, an embedding error, or an abort rejects instead. The
service turns that, or a timeout, into a log line (see
[contracts/learning-reflector.md](contracts/learning-reflector.md)).

## Background task

`BackgroundTasks` (`src/http/background-tasks.ts`) holds the pending learning promises of the
process.

| Member | Behaviour |
| --- | --- |
| `track(task: Promise<unknown>)` | adds the task; removes it when it settles, whether it resolves or rejects |
| `settled(): Promise<void>` | resolves once no task is pending, including tasks added while waiting |
| `pending: number` | how many tasks are pending (for tests) |

## `ForgetPreferenceInput` (`src/domain/schemas.ts`)

| Field | Type | Rule |
| --- | --- | --- |
| `description` | string | `MemoryFact` limits: trimmed, 1 to 500 characters |

## Constants

| Name | Value | Where |
| --- | --- | --- |
| `LEARNING_TOOL_NAME` | `"record_learning"` | `src/agents/learning-reflector.ts` |
| `LEARNING_TIMEOUT_MS` | `30_000` | `src/http/server.ts` (default of `AppSettings.learningTimeoutMs`) |
| `FORGET_MIN_SCORE` | `0.5` | `src/memory/memory-store.ts` |
| `DUPLICATE_THRESHOLD` | `0.92` | unchanged from 008 |
| `RECALL_MIN_SCORE`, `RECALL_LIMIT` | `0.3`, `3` | unchanged from 008 |

## State transitions of one request with a `userId`

```text
run completes ──▶ history saved ──▶ step tracked ──▶ reply sent
                                        │
                                        ├─▶ verdict ─▶ skip ............ (nothing written)
                                        ├─▶ verdict ─▶ save ─▶ remember ─▶ saved | duplicate
                                        └─▶ failure | timeout ........... (logged, nothing written)

run ends without an answer (iteration limit, error, timeout) ──▶ no step
request without userId ──▶ no step
```
