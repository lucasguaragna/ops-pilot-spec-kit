# Contract: Agent Tools

**File**: `src/agents/tools.ts` | `createTools(store: OpsStore)` returns a tuple, in this order:

```ts
[list_alerts, open_incident, resolve_incident, list_incidents, get_runbook]
```

The order appends the new tools, so the existing destructuring in tests keeps working. Every tool
returns JSON text. Domain errors come back as `Error: <message>` text and the run continues. Input
that fails zod is rejected before the store is called.

## The six description rules

Every tool, old and new, MUST meet all six:

1. **What**: one sentence on what the tool does.
2. **When**: the situations that call for it, and when to use another tool instead.
3. **Arguments**: every zod field has `.describe()`, with no undescribed argument.
4. **Closed sets**: every closed set is a `z.enum`, and its values are named in the describe text.
5. **Returns**: the shape of the result, and the error text the model can get back.
6. **Identifiers**: how to refer to records (`ALT-NNN`, `INC-NNN`, exact service names) and which
   tool lists them.

`src/agents/tools.test.ts` checks rules 3 and 4 mechanically by walking each tool's zod schema.
Rules 1, 2, 5, and 6 are checked by review against the table below.

## Tools

| Tool | Input (zod) | Returns | Errors as text | "When" (rule 2) |
| --- | --- | --- | --- | --- |
| `list_alerts` | `status`: `firing \| resolved \| all`, default `firing` | `Alert[]` with `firedAt` | none | the engineer asks what is firing, how services or the shift are doing, or which alert is oldest |
| `open_incident` | `title` (short summary); `service` (exact name from `list_alerts`); `severity`: `low \| medium \| high \| critical` (sev1 critical ... sev4 low) | `Incident` with its new `INC-NNN` id | Service not found (lists known services) | an alert needs follow-up **and** `list_incidents` shows no open incident for that service and problem; not for questions or status checks |
| `resolve_incident` | `id` (`INC-NNN`, from `list_incidents`); `summary` (optional, what fixed it) | the resolved `Incident` with `resolvedAt` and `summary` | Incident not found; Incident already resolved | the engineer says an incident is fixed or asks to close it |
| `list_incidents` | `status`: `open \| resolved \| all`, default `open` | `Incident[]`, ordered by id | none | the engineer asks about incidents or the shift, before `open_incident` to avoid duplicates, and to find an id for `resolve_incident` |
| `get_runbook` | `service` (exact name from `list_alerts`) | `Runbook` `{ service, title, steps[] }` | Service not found (lists known services); No runbook for service (lists services with runbooks) | the engineer asks how to handle or fix an alert or service |

## Tests

- **Names**: the five names, in tuple order.
- **Rules 3 and 4**: for each tool, every field in the schema shape has a non-empty description,
  and the fields `status` and `severity` are `ZodEnum` (unwrapping the default).
- **Rule 2 for `open_incident`**: the description mentions `list_incidents`.
- **Behaviour**: every existing case runs on `new SqliteOpsStore(":memory:")`. New cases cover
  `list_incidents` with its default and with each filter, `get_runbook` for found, no runbook, and
  unknown service, and `resolve_incident` with a summary.
- An invalid enum (`status: "closed"`, `severity: "urgent"`) is rejected and the store is
  unchanged.
