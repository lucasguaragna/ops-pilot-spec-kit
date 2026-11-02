# Data Model: Chat Endpoint

No stored data changes. The entities below are request, reply, and registry shapes. Existing types
come from `src/domain/types.ts`.

## RunOptions (changed)

| Field | Type | Rule |
| --- | --- | --- |
| `maxIterations` | positive integer | Unchanged; the endpoint uses 10 |
| `signal` | `AbortSignal`, optional | New. Once aborted, no new model or tool call starts |

Every strategy, including `withReflection`, passes `signal` to all of its model, tool, and
base-strategy calls.

## ChatRequest (HTTP body, validated)

| Field | Type | Rule |
| --- | --- | --- |
| `message` | string | Required; trimmed; at least 1 character |
| `strategy` | string | Optional; default `react`; must be a registry name, checked after the schema |
| `reflect` | boolean | Required; strings such as `"true"` fail |

Unknown fields are dropped. Validation order: JSON parse, then schema (400), then strategy name
(422).

## ChatReply (200)

| Field | Type | Rule |
| --- | --- | --- |
| `answer` | string or null | String when `stopReason` is `completed`; null at the iteration limit |
| `stopReason` | `completed` or `iteration_limit` | Never `error`; errors reply 502 |
| `trace` | `TraceEvent[]` | As in `src/domain/types.ts` |
| `metrics` | `{ llmCalls, latencyMs }` | Non-negative integers |

## ErrorReply

Every error body has `error` (a kind) and `message` (readable text), plus fields for its kind. No
body holds a stack trace, a setting's value, or a secret.

| Status | `error` | Extra fields |
| --- | --- | --- |
| 400 | `invalid_body` | `issues: { path: (string or number)[], message: string }[]` |
| 422 | `unknown_strategy` | `strategy: string`, `knownStrategies: string[]` |
| 502 | `run_failed` | `runError: { name, message }`, `trace` and `metrics` when the run returned them |
| 504 | `timeout` | `timeoutMs: number` |
| 500 | `internal` | None; only for bugs, such as a reply failing its own schema |

## StrategyRegistry

| Element | Shape |
| --- | --- |
| `StrategyFactory` | `(dependencies: StrategyDependencies) => ReasoningStrategy` |
| `StrategyRegistry` | `Readonly<Record<string, StrategyFactory>>` |
| `strategyFactories` | `{ react, "plan-execute" }` |
| `createStrategy` | `(registry, name, dependencies, { reflect }) => ReasoningStrategy`; throws `UnknownStrategyError` |

With `reflect: true` the result is `withReflection(base, { model: dependencies.model })`, named
`reflect:<name>`.

## UnknownStrategyError (new domain error)

`class UnknownStrategyError extends Error` in `src/domain/errors.ts`, with `strategy` and
`knownStrategies`. Its message names both. The controller translates it to 422; the arena never
sees it because its names come from the registry.

## Run outcome to HTTP status

```text
run(signal) ──► timer fires first ─────────────► abort(signal) ─► 504 timeout
            ├─► returns stopReason completed ──────────────────────► 200
            ├─► returns stopReason iteration_limit ────────────────► 200, answer null
            ├─► returns stopReason error ──────────────────────────► 502 with trace and metrics
            └─► throws ────────────────────────────────────────────► 502 without trace
```
