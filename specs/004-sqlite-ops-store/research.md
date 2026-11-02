# Research: SQLite Ops Store

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-11-02

Every decision below was checked on the local Node.js v24.15.0 (SQLite 3.51.3). The Node 22 docs
for `node:sqlite` were read through Context7 (`/websites/nodejs_latest-v22_x_api`).

## R1. Driver and connection options

- **Decision**: Use `new DatabaseSync(path)` from `node:sqlite` with no constructor options. Right
  after opening, run `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000`.
- **Rationale**: In Node 22 the `timeout` constructor option only exists from v22.18 ("Add new
  SQLite database options"), and the constitution's floor is 22.13. The pragmas give the same
  behaviour on every supported version. `enableForeignKeyConstraints` already defaults to `true`;
  setting the pragma anyway keeps the intent visible. The busy timeout covers the dev server and
  the arena opening the same file at once.
- **Alternatives considered**: `better-sqlite3` (a new dependency the constitution rules out); the
  `timeout` option (needs Node 22.18 or newer).

## R2. Interface name and shape

- **Decision**: Rename `Store` to `OpsStore` and move it to its own file,
  `src/store/ops-store.ts`. Both `createStore` (memory) and `SqliteOpsStore` implement it. Extend
  it with `listIncidents(filter)` and `getRunbook(service)`, and have `resolveIncident` take
  `{ id, summary? }`. Keep `getState()` and `reset()`.
- **Rationale**: The user named the interface `OpsStore`. The tools and the bench depend only on
  the interface, so the two stores can swap (FR-002). The bench judge reads `getState()`, and the
  `npm run seed` reset needs `reset()`.
- **Alternatives considered**: Keep the name `Store`, which conflicts with the spec's wording.
  Drop `getState()` from the SQLite store, which would make the bench and the tool tests depend
  on the memory store only.

## R3. Class versus factory

- **Decision**: Write `SqliteOpsStore` as a class. The constructor opens the database, runs the
  DDL, seeds, and prepares every statement once into private fields. Add `close()` on the class
  only, not on the interface. Keep the decisions that matter (id format, filters, error choice) as
  pure functions shared with the memory store.
- **Rationale**: The user asked for "DDL in the constructor", and a class keeps the prepared
  statements together with the connection. Principle IV is met because the class is the edge
  (database side effects) and the logic stays pure.
- **Alternatives considered**: A `createSqliteOpsStore(path)` factory. It would match
  `createStore`, but it goes against the name and shape the user asked for.

## R4. Prepared statements, DDL and transactions

- **Decision**: Every read and write that carries a value goes through
  `db.prepare(sql).run/get/all(...params)` with `?` placeholders. `db.exec` is used only for
  constant text with no values: the schema DDL, the pragmas, and `BEGIN`/`COMMIT`/`ROLLBACK`. A
  small `transaction(db, fn)` helper wraps the seed, `reset`, and `openIncident`.
- **Rationale**: The constitution forbids building SQL from values. DDL and transaction control
  have no values, and `exec` is the documented way to run them. A test stores the title
  `x'); DROP TABLE alerts;--` verbatim (spec edge case).
- **Alternatives considered**: Preparing the DDL too. It adds no safety, because the text is
  constant, and `prepare` runs only one statement at a time.

## R5. CHECK constraints and STRICT tables

- **Decision**: Write the DDL as literal text with `CHECK (severity IN ('low','medium','high','critical'))`,
  `CHECK (status IN (...))` and `CHECK (tier IN (1,2,3))`. Every table is `STRICT`. A test inserts
  every value of each zod enum (it must pass) and one value outside it (it must fail), so the DDL
  and the domain cannot drift apart.
- **Rationale**: `STRICT` (SQLite 3.37+) stops a column from silently storing `'2'` in place of
  `2`. Literal DDL is easy to read and review. The parity test enforces "CHECKs mirror the domain
  types". Verified: `CHECK constraint failed: n in (1,2,3)`.
- **Alternatives considered**: Generating the CHECK lists from `Severity.options`. It is tidier,
  but it is string building inside SQL, which a reviewer would have to reason about against FR-008.

## R6. Incident ids across restarts

- **Decision**: The incidents table has `id TEXT PRIMARY KEY`. Inside the `openIncident`
  transaction, the next number is
  `SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 0) + 1 FROM incidents`, and a pure
  `formatIncidentId(n)` returns `INC-NNN`. The memory store keeps `nextIncidentNumber` in its
  state, and `getState()` on SQLite computes the same value from the table.
- **Rationale**: Incidents are never deleted, so `MAX + 1` never reuses an id after a restart
  (spec edge case). It also adds no fifth table, since the user fixed the schema at four tables.
  `DatabaseSync` is synchronous and the app has one connection, so there is no race inside a
  process.
- **Alternatives considered**: `INTEGER PRIMARY KEY AUTOINCREMENT` with an id derived from it. It
  needs an insert followed by an update, or a generated column. A counter table would be a fifth
  table.

## R7. Seed and reset

- **Decision**: Every open runs the seed in one transaction with
  `INSERT ... ON CONFLICT DO NOTHING` for services, alerts, and runbooks, all taken from
  `seed-data.ts`. `reset()` deletes all rows (incidents, runbooks, alerts, services, in that order)
  and runs the seed again. `npm run seed` opens the store at `OPSPILOT_DB`, calls `reset()`, and
  prints the counts, as it does today for the JSON file.
- **Rationale**: `DO NOTHING` never overwrites a row changed after the seed, so a resolved alert
  stays resolved (FR-004 and the spec edge case). One source module feeds both stores (FR-005).
- **Alternatives considered**: `INSERT OR REPLACE`. It would reopen alerts the team has resolved.

## R8. Runbook storage and errors

- **Decision**: Runbooks are stored in the table
  `runbooks(service TEXT PRIMARY KEY REFERENCES services(name), title TEXT, steps TEXT)`, with
  `steps` holding a JSON array of strings, parsed with zod on read. `getRunbook` throws
  `ServiceNotFoundError` for an unknown service. For a known service with no runbook it throws a
  new `RunbookNotFoundError(service, servicesWithRunbooks)` that extends `DomainError`.
- **Rationale**: The schema stays at four tables, steps keep their order, and the agent only reads
  them. Both errors reach the model as `Error: ...` text that names its next options (US3).
- **Alternatives considered**: A `runbook_steps` table, which would be a fifth table. Free text
  with newlines, which loses the step structure.

## R9. Path, directory, and open errors

- **Decision**: A pure `resolveDbPath(env)` parses `OPSPILOT_DB` with the zod schema
  `z.string().trim().min(1).optional().catch(undefined)` (Principle II: environment input is
  validated at the boundary) and returns the parsed value or `./data/opspilot.db`. Unset, empty,
  or blank all give the default. `openOpsStore(env)`:
  - runs `mkdirSync(dirname(path), { recursive: true })` unless the path is `:memory:`;
  - builds the store;
  - wraps any failure in `StoreOpenError(path, reason)`, which is not a `DomainError`, because the
    model never sees it.

  `index.ts` and `arena.ts` call it once at startup, and on `StoreOpenError` print the message and
  exit with code 1. The new error replaces `StoreFileError`.
- **Rationale**: This meets the spec edge cases: a missing directory is created, and an unwritable
  path gives a clear error naming the path. A relative path is resolved from the working
  directory, which is the repository root for `npm run` scripts.
- **Alternatives considered**: Resolving the path from `import.meta.url` as the JSON store did.
  The user gave a cwd-relative default, and keeping it makes `OPSPILOT_DB=./tmp.db` behave as
  expected.

## R10. One store per process

- **Decision**: `index.ts` opens the store once and `createDependencies` reuses it on every
  request. The bench and the tests build a fresh memory or `:memory:` store per run.
- **Rationale**: Each `DatabaseSync` is one connection. Opening one per request would repeat the
  DDL and seed and leave connections behind. Calls are synchronous, so concurrent requests cannot
  interleave inside a statement.
- **Alternatives considered**: One store per request, as with the JSON backend. That only worked
  because the JSON backend read the file on every call.

## R11. Tool descriptions (the six rules)

- **Decision**: Every tool description states:
  1. what the tool does;
  2. when to use it (and when not to);
  3. what each argument means, through `.describe()` on every zod field;
  4. the allowed values of closed sets, as `z.enum` (never free text);
  5. what it returns;
  6. how to identify records (`INC-NNN`, `ALT-NNN`, exact service names, and the tool that lists
     them).

  The `.describe()` calls live on the input schemas in `src/domain/schemas.ts`, so the zod
  boundary and the model see the same text.
- **Rationale**: FR-011 and US4. It pays the `open_incident` debt: when to use it, which is an
  alert that needs follow-up and has no open incident yet (check with `list_incidents` first).
  LangChain sends `.describe()` text as the JSON Schema `description`.
- **Alternatives considered**: Descriptions only at the tool level, as today. The model then sees
  arguments with no description in the JSON Schema.

## R12. Leftovers retired by this feature

- **Decision**:
  - Delete `json-file-store.ts`, its test, and `StoreFileError`.
  - Remove the unused `sequelize` dependency.
  - Update the `.gitignore` comment, the README persistence notes, and the constitution's Stack
    Exceptions. The JSON exception ends when this feature ships, which is a PATCH amendment
    (1.3.1).
- **Rationale**: The constitution says the exception ends when SQLite ships and that there is no
  ORM. Dead code would invite drift. `data/db.json` is not migrated (spec assumption).
- **Alternatives considered**: Keeping the JSON backend as a fallback. Nothing uses it once the
  composition switches.
