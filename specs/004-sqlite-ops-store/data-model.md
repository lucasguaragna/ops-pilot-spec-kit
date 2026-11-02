# Data Model: SQLite Ops Store

**Feature**: [spec.md](spec.md) | **Research**: [research.md](research.md)

The domain types in `src/domain/schemas.ts` are the source of truth. The tables below mirror them,
and every closed set is enforced twice: by zod at the boundary, and by a `CHECK` in the database.

## Domain types (changes)

| Type | Change |
| --- | --- |
| `ServiceTier` | New: `z.union([z.literal(1), z.literal(2), z.literal(3)])`. 1 critical, 2 important, 3 auxiliary |
| `Service` | Gains `tier: ServiceTier` |
| `Incident` | Gains `resolvedAt: z.iso.datetime().nullable()` and `summary: z.string().min(1).nullable()`. Both are `null` while `open` |
| `Runbook` | New: `{ service: string, title: string, steps: string[] (min 1) }` |
| `IncidentFilter` | New: `z.enum(["open", "resolved", "all"])` |
| `ListIncidentsInput` | New: `{ status: IncidentFilter.default("open") }` |
| `GetRunbookInput` | New: `{ service: z.string().trim().min(1) }` |
| `ResolveIncidentInput` | Gains `summary: z.string().trim().min(1).optional()` |
| `StoreState` | Gains `runbooks: readonly Runbook[]` |

Every input field gets a `.describe()` (rule 3 in [contracts/agent-tools.md](contracts/agent-tools.md)).

## Tables

All tables are `STRICT`. The DDL uses `CREATE TABLE IF NOT EXISTS` and runs on every open.

### services

| Column | Type | Constraints |
| --- | --- | --- |
| `name` | TEXT | PRIMARY KEY, `CHECK (length(name) > 0)` |
| `tier` | INTEGER | NOT NULL, `CHECK (tier IN (1, 2, 3))` |

Read order: `rowid`, the seed order. The `Known services: ...` error text depends on it.

### alerts

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | TEXT | PRIMARY KEY |
| `title` | TEXT | NOT NULL, `CHECK (length(title) > 0)` |
| `service` | TEXT | NOT NULL, REFERENCES `services(name)` |
| `severity` | TEXT | NOT NULL, `CHECK (severity IN ('low', 'medium', 'high', 'critical'))` |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('firing', 'resolved'))` |
| `fired_at` | TEXT | NOT NULL (ISO 8601 UTC) |

Read order: `id`.

### incidents

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | TEXT | PRIMARY KEY (`INC-NNN`) |
| `title` | TEXT | NOT NULL, `CHECK (length(title) > 0)` |
| `service` | TEXT | NOT NULL, REFERENCES `services(name)` |
| `severity` | TEXT | NOT NULL, same CHECK as alerts |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('open', 'resolved'))` |
| `resolved_at` | TEXT | NULL (ISO 8601 UTC) |
| `summary` | TEXT | NULL |

Table-level CHECK: `(status = 'open' AND resolved_at IS NULL AND summary IS NULL) OR
(status = 'resolved' AND resolved_at IS NOT NULL)`.

Read order: `id`. The zero padding keeps text order equal to number order up to `INC-999`. For
larger numbers the query orders by `CAST(substr(id, 5) AS INTEGER)`.

### runbooks

| Column | Type | Constraints |
| --- | --- | --- |
| `service` | TEXT | PRIMARY KEY, REFERENCES `services(name)` |
| `title` | TEXT | NOT NULL, `CHECK (length(title) > 0)` |
| `steps` | TEXT | NOT NULL, a JSON array of non-empty strings, `CHECK (json_valid(steps))`; parsed with zod on read |

## Row mapping

Pure functions `toService`, `toAlert`, `toIncident`, and `toRunbook`:

- map `snake_case` rows to the domain types (`fired_at` to `firedAt`, `resolved_at` to
  `resolvedAt`);
- parse each row with the domain zod schema, so a row edited by hand fails loudly instead of
  leaking bad data to the model.

## State transitions: Incident

```text
(none) --openIncident{title, service, severity}--> open      resolvedAt=null, summary=null
open   --resolveIncident{id, summary?}----------> resolved  resolvedAt=now(), summary=summary ?? null
resolved --resolveIncident-----------------------> IncidentAlreadyResolvedError (no change)
```

- Opening an incident on an unknown service throws `ServiceNotFoundError` with the known services.
- Resolving an unknown id throws `IncidentNotFoundError`.
- `now` is injected (`() => string`, default `new Date().toISOString()`), so the pure transitions
  and the tests stay deterministic.

Alerts are read-only in this feature. Runbooks are read-only for the agent.

## Seed (`src/store/seed-data.ts`, shared by both stores)

| Service | Tier | Runbook |
| --- | --- | --- |
| checkout-api | 1 | yes |
| payments-worker | 1 | yes |
| auth-service | 1 | yes |
| search-api | 2 | no |
| catalog-api | 2 | no |
| notification-service | 3 | no |

- Services keep the current array order; only the `tier` is new.
- The alerts `ALT-001` to `ALT-007` are unchanged: 4 firing and 3 resolved.
- There are no incidents.
- Each runbook has a title and 3 to 5 ordered steps tied to its alerts (latency and pod restarts
  for checkout, queue backlog for payments, login error rate for auth). The exact text is written
  at implementation time.

## Errors

| Error | Kind | When |
| --- | --- | --- |
| `ServiceNotFoundError` | DomainError (existing) | open_incident or get_runbook on an unknown service |
| `IncidentNotFoundError` | DomainError (existing) | resolve on an unknown id |
| `IncidentAlreadyResolvedError` | DomainError (existing) | resolve twice |
| `RunbookNotFoundError` | DomainError (new) | known service with no runbook; the message lists the services that have one |
| `StoreOpenError` | Error (new, replaces `StoreFileError`) | the database cannot be opened or created; the message names the path and the reason |
