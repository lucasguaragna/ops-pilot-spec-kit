# Data Model: OpsPilot MCP Server

No new persisted data. `Alert`, `Incident`, `Service`, `Runbook` and the SQLite schema are
unchanged (see `specs/004-sqlite-ops-store/data-model.md`). This feature adds in-code shapes only.

## ToolDefinition (`src/tools/definitions.ts`)

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string literal | snake_case, unique across all definitions |
| `description` | string | Moved verbatim from today's `createTools`; English, model-facing |
| `schema` | zod object | The existing input schema from `src/domain/schemas.ts`, by reference, never copied |
| `run` | `(store: OpsStore, input: z.output<schema>) => unknown` | Present for the five store tools; the single store call each tool makes |

Definitions (all six move here; only the first three are exposed over MCP):

| Name | Schema | `run` |
| --- | --- | --- |
| `list_alerts` | `ListAlertsInput` | `store.listAlerts(status)` |
| `open_incident` | `OpenIncidentInput` | `store.openIncident(input)` |
| `resolve_incident` | `ResolveIncidentInput` | `store.resolveIncident({ id, summary })` |
| `list_incidents` | `ListIncidentsInput` | `store.listIncidents(status)` |
| `get_runbook` | `GetRunbookInput` | `store.getRunbook(service)` |
| `check_provider_status` | `CheckProviderStatusInput` | none: handler stays in `createTools` (needs `deps`) |

The MCP exposure list is a constant in `src/mcp/create-server.ts`:
`["list_alerts", "open_incident", "resolve_incident"]`.

## ToolOutcome

`{ text: string; isError: boolean }`, produced only by `runToolText(action)`.

| Case | `text` | `isError` |
| --- | --- | --- |
| `action` returns a value | `JSON.stringify(value)` | `false` |
| `action` throws a `DomainError` | `Error: <message>` | `true` |
| `action` throws anything else | (re-thrown, no outcome) | n/a |

Edge mapping:

- Agent tool: returns `text`. Same string as before this feature.
- MCP tool: returns `{ content: [{ type: "text", text }], isError }`. A re-thrown error becomes
  `{ content: [{ type: "text", text: "Error: internal error" }], isError: true }` plus a stderr line.

## Server identity

| Field | Value |
| --- | --- |
| `name` | `opspilot` |
| `version` | `version` from `package.json` (today `0.1.0`) |
| Capabilities | `tools` only |

## Process states (`src/mcp/server.ts`)

```text
starting --store opened--> connected --stdin end | transport close | SIGINT | SIGTERM--> stopped (exit 0)
starting --StoreOpenError--> failed (stderr reason, exit 1)
```

`stopped` is reached once; later shutdown triggers are ignored.
