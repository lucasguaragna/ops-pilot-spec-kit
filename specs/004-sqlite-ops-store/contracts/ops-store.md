# Contract: OpsStore

**File**: `src/store/ops-store.ts` | **Implementations**: `createStore()` (memory, in
`src/store/in-memory-store.ts`) and `SqliteOpsStore` (`src/store/sqlite-ops-store.ts`)

Both implementations MUST pass one shared test suite (`src/store/ops-store-contract.ts`, imported
by both store test files), so they return the same results for the same calls (FR-002).

```ts
export interface OpsStore {
  getState(): StoreState;                                    // full snapshot, used by the bench judge and tests
  listAlerts(status: AlertFilter): Alert[];                  // ordered by id
  listIncidents(status: IncidentFilter): Incident[];         // ordered by incident number
  getRunbook(service: string): Runbook;                      // throws ServiceNotFoundError | RunbookNotFoundError
  openIncident(input: OpenIncidentInput): Incident;          // throws ServiceNotFoundError
  resolveIncident(input: ResolveIncidentInput): Incident;    // throws IncidentNotFoundError | IncidentAlreadyResolvedError
  reset(): void;                                             // back to the seed (no incidents)
}
```

## Behaviour both stores share

| Call | Given | Result |
| --- | --- | --- |
| `getState()` after open | fresh store | deep-equals `createInitialState()` |
| `listAlerts("firing")` | seed | `ALT-001`, `ALT-002`, `ALT-003`, `ALT-007` |
| `openIncident` ×2 | seed | `INC-001`, then `INC-002`; both `open`, `resolvedAt` and `summary` `null` |
| `resolveIncident({ id, summary })` | open incident | `resolved`, `resolvedAt` = `now()`, `summary` kept |
| `resolveIncident({ id })` | open incident | `resolved`, `summary` is `null` |
| `listIncidents("open" \| "resolved" \| "all")` | 2 open, 1 resolved | 2, 1, or 3 incidents |
| `getRunbook("checkout-api")` | seed | title and ordered steps |
| `getRunbook("search-api")` | seed | `RunbookNotFoundError`, whose message lists checkout-api, payments-worker, auth-service |
| `getRunbook("nope")` | seed | `ServiceNotFoundError`, whose message lists the known services |
| `openIncident` with title `x'); DROP TABLE alerts;--` | seed | stored verbatim; alerts still listed |
| `openIncident` with service `nope` | seed | `ServiceNotFoundError`; no incident stored |
| `resolveIncident({ id: "INC-999" })` | seed | `IncidentNotFoundError` |
| `resolveIncident` twice on one id | open incident | second call: `IncidentAlreadyResolvedError`; `resolvedAt` unchanged |
| `reset()` | incidents exist | `getState()` deep-equals `createInitialState()` |

## SQLite-only behaviour

| Case | Result |
| --- | --- |
| `new SqliteOpsStore(":memory:")` | schema and seed created |
| Open the same file twice (close in between) | same counts as the seed; incidents and changed alerts kept; next id continues (`INC-002` after `INC-001`) |
| Open 10 times on one file | services 6, alerts 7, runbooks 3 (SC-002) |
| Seeded alert set to `resolved`, then reopened | still `resolved` |
| Direct insert with alert or incident severity `urgent`, alert or incident status `closed`, tier `4`, or an open incident with `resolved_at` | `CHECK constraint failed` |
| Every value of `Severity`, `AlertStatus`, `IncidentStatus`, `ServiceTier` | accepted (CHECK and zod in step) |
| `openOpsStore({ OPSPILOT_DB: "<missing dir>/x.db" })` | directory created, store opens |
| `openOpsStore({ OPSPILOT_DB: "<unwritable path>" })` | `StoreOpenError` naming the path |
| `close()` | the connection is closed; later calls throw |

## Construction

```ts
resolveDbPath(env: NodeJS.ProcessEnv): string                     // pure: OPSPILOT_DB parsed by zod (trim, min 1) or "./data/opspilot.db"
openOpsStore(env?: NodeJS.ProcessEnv, options?: { now?: () => string }): SqliteOpsStore   // mkdir + open, StoreOpenError on failure
new SqliteOpsStore(path: string, options?: { now?: () => string })
createStore(options?: { initial?: StoreState; now?: () => string }): OpsStore   // memory
```

The `StoreBackend` and `createMemoryBackend` indirection is removed with the JSON backend, and the
memory store keeps its state in a closure. If the implementation finds a reason to keep the
backend, the public `createStore()` call with no arguments must still work as the bench and tests
use it.
