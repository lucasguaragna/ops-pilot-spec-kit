# Data Model: Model Fallback

Nothing is stored. Every entity is in memory or on the wire.

## Model settings (`src/agents/model.ts`)

| Field | Type | Rule |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | string | Required, trimmed, non-empty (unchanged) |
| `OPENROUTER_MODEL` | string | Required, trimmed, non-empty (unchanged) |
| `OPENROUTER_MODEL_FALLBACK` | string, optional | Trimmed. Empty or equal to `OPENROUTER_MODEL` means no fallback (FR-002) |

A missing required field still throws `ConfigurationError` with the field names only.

## `ResilientChatModel` (`src/agents/resilient-model.ts`)

| Field | Type | Notes |
| --- | --- | --- |
| `primary` | `BaseChatModel` | Built with `maxRetries: 0` |
| `fallback` | `BaseChatModel \| undefined` | Built with `maxRetries: 0`; retried like the primary (R3) |
| `primaryName`, `fallbackName` | string | Model names; only they reach the trace |
| `attempts` | number | Attempts per model; `MODEL_ATTEMPTS = 2` by default |

Every composition sets run metadata `opspilotModel` and `opspilotModelRole` (R5).

## Switch (collected by `LlmCallCounter`)

| Field | Type | Notes |
| --- | --- | --- |
| `from` | string | Primary model name |
| `to` | string | Fallback model name |
| `error` | string | Class name of the primary's final error; never its message (FR-008) |

The counter also gains `modelUsed: string | null`: the model of the last call that finished.

## `fallback` trace event

`TraceEvent` gains `{ type: "fallback"; from: string; to: string; error: string }`. Like every
event it gets a `node` as a `NodeTraceEvent`. Placement follows research R8.

## `Metrics`

`Metrics` gains `modelUsed: string | null` (FR-009). It is null only when no call of the run
finished. Graph reducer: newest non-null wins. `llmCalls` counts every started request, retries
included (FR-010).

## `ModelUnavailableError` (`src/domain/errors.ts`)

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `"ModelUnavailableError"` | Matched by name at the edge |
| `causeName` | string | Class name of the wrapped error |
| `message` | string | Fixed text; no provider text, no key |
| `cause` | unknown | The original error, for the server log only |

It is an edge error like `ConfigurationError`, not a `DomainError`: the model cannot recover from it.

## `RunError`

Gains optional `cause?: string`, set by `toRunError` from `ModelUnavailableError.causeName`.

## States of one model call

```text
primary attempt n ── ok ────────────────────────────────► answered (modelUsed = primary)
       │ retryable, n < attempts ──► primary attempt n+1
       │ not retryable, or n = attempts
       ├─ aborted ─────────────────────────────────────► rethrown as is (504)
       ├─ no fallback ─────────────────────────────────► ModelUnavailableError (503)
       └─ fallback set ──► switch recorded ──► fallback attempt
                                                ├─ ok ──► answered (modelUsed = fallback)
                                                ├─ aborted ──► rethrown as is (504)
                                                └─ fails ──► ModelUnavailableError (503)
```

A step that catches the error (router, reflection's critic and rewrite) keeps its current handling:
the router falls back to its default route, and reflection keeps the draft. Only a failure that ends
the run reaches the 503.
