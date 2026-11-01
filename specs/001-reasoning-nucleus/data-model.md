# Data Model: Reasoning Nucleus

## Enumerations

- **Severity**: `low`, `medium`, `high`, `critical`
- **AlertStatus**: `firing`, `resolved`
- **IncidentStatus**: `open`, `resolved`
- **StopReason**: `completed`, `iteration_limit`, `error`

## Service

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | Non-empty, unique |

## Alert

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Unique, for example `ALT-001` |
| `title` | string | Non-empty |
| `service` | string | Must match a Service |
| `severity` | Severity | |
| `status` | AlertStatus | |

Alerts are read-only in this feature.

## Incident

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Sequential: `INC-001`, `INC-002` |
| `title` | string | Non-empty |
| `service` | string | Must match a Service |
| `severity` | Severity | |
| `status` | IncidentStatus | Starts as `open` |

State transition: `open` to `resolved`. A resolved incident cannot change again.

## StoreState

Immutable. Holds `services`, `alerts`, `incidents`, and `nextIncidentNumber`. Transitions return a
new state and never change the previous one. Identifiers restart with the seed, which keeps runs
comparable.

## Seed

5 services and 6 alerts: 3 `firing` and 3 `resolved`, across varied services and severities. No
incidents.

## TraceEvent

A union discriminated by `type`:

| `type` | Fields |
| --- | --- |
| `thought` | `content: string` |
| `action` | `tool: string`, `args: Record<string, unknown>` |
| `observation` | `tool: string`, `content: string` |
| `plan` | `steps: string[]` |
| `critique` | `content: string` (reserved; no strategy emits it yet) |
| `answer` | `content: string` |

## Metrics

| Field | Type | Rules |
| --- | --- | --- |
| `llmCalls` | number | Integer, 0 or more |
| `latencyMs` | number | 0 or more |

## RunResult

A union discriminated by `stopReason`, so invalid combinations do not compile. `trace` and `metrics`
are always present, and `trace` keeps its order even when a run fails.

```ts
type RunResult = { trace: TraceEvent[]; metrics: Metrics } & (
  | { stopReason: "completed"; answer: string }
  | { stopReason: "iteration_limit"; answer: null }
  | { stopReason: "error"; answer: null; error: RunError }
);

interface RunError {
  name: string;
  message: string;
}
```

`RunError` is plain data, not an `Error` instance, so results stay printable and serializable. Its
message never holds a secret.

`stopReason` and `error` extend the interface in the request so that a limit or failure can be
reported without losing the trace.

## Domain errors

- `ServiceNotFoundError`
- `IncidentNotFoundError`
- `IncidentAlreadyResolvedError`
- `ConfigurationError`: names the missing setting, never its value
