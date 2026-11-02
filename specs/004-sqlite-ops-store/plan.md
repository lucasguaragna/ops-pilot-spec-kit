# Implementation Plan: SQLite Ops Store

**Branch**: `004-sqlite-ops-store` (name only; work is on `main`) | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-sqlite-ops-store/spec.md`

## Summary

`Store` becomes `OpsStore`, which adds `listIncidents`, `getRunbook`, and a summary on resolve. A
new `SqliteOpsStore` class implements it on `node:sqlite` `DatabaseSync`:

- **Opening**: the constructor runs idempotent `STRICT` DDL with `CHECK`s on every closed field,
  then an `ON CONFLICT DO NOTHING` seed taken from the same `seed-data.ts` as the memory store.
- **Queries**: every query is prepared once with bound parameters.
- **Startup**: `openOpsStore` resolves `OPSPILOT_DB` (default `./data/opspilot.db`) and creates the
  directory. `index.ts` and `arena.ts` open one store per process. The bench keeps a fresh memory
  store per run.
- **Domain**: services gain `tier`, incidents gain `resolvedAt` and `summary`, and runbooks are a
  new read-only entity.
- **Tools**: two new tools, `list_incidents` and `get_runbook`. All five descriptions are
  rewritten to the six rules, with `.describe()` on every field.
- **Removals**: the JSON file store, `StoreFileError`, and `sequelize`.
- **Tests**: one shared contract suite proves the two stores behave the same.

See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js 22.13+ (local v24.15.0,
SQLite 3.51.3)

**Primary Dependencies**:

- Existing: `zod` 4, `langchain` 1.6, `@langchain/core` 1.3, `@langchain/langgraph` 1.6, `express` 5.
- Built-in: `node:sqlite`.
- Removed: `sequelize`.

**Storage**: SQLite file at `OPSPILOT_DB` (default `./data/opspilot.db`) with 4 tables; `":memory:"`
in tests; in-memory `createStore()` for the bench

**Testing**: `node:test` through `tsx`. A shared `OpsStore` contract suite runs against both stores.
SQLite-only tests use `:memory:` by default. The tests that need a file (open 10 times, restart,
a changed alert survives a reopen, and the two `openOpsStore` directory cases) use a fresh
`mkdtemp` directory in `os.tmpdir()`, removed in `after`, as constitution 1.3.0 allows. Tool-schema
checks walk the zod shapes.

**Target Platform**: Local HTTP server and CLI (arena, bench, seed)

**Project Type**: Web service and CLI over the agent library

**Performance Goals**: None beyond today. The dataset is a few dozen rows, and the statements are
prepared once per store.

**Constraints**:

- No SQL built from values (FR-008).
- Exactly 4 tables.
- The test suite never touches `data/` (SC-005).
- The store is opened once per process.
- Node 22.13 API only, so the busy timeout is set with a pragma instead of the `timeout` option.

**Scale/Scope**: 1 new store class, 1 renamed interface, 2 new tools, 5 tool descriptions, 3
entry points rewired (`index.ts`, `arena.ts`, `seed.ts`), 1 module removed

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | Model: `src/store/*` and `src/domain/*` hold all SQL. Service and agent tools call `OpsStore` only. The controller is unchanged. |
| II. Validated Boundaries | Pass | Tool inputs are zod schemas (new `ListIncidentsInput`, `GetRunbookInput`, `summary`). Database rows are parsed with the domain zod schemas on read. `OPSPILOT_DB` is parsed with a zod schema inside the pure `resolveDbPath`. |
| III. Domain Errors at the Edge | Pass | New `RunbookNotFoundError` (a DomainError) is turned into tool text by `toToolText`. New `StoreOpenError` is caught only at the entry points (`index.ts`, `arena.ts`, `seed.ts`). |
| IV. Pure Functions | Pass | `formatIncidentId`, `resolveDbPath`, the row mappers, the filters, and the memory transitions (with `now` passed in) are pure. `SqliteOpsStore` is the side-effect edge. |
| V. Tested and Green | Pass | Contract suite for both stores, plus SQLite tests (seed, idempotence, restart, CHECKs, injection) and tool tests on `:memory:`. Typecheck and tests gate the work. |
| Stack: `node:sqlite`, no ORM | Pass | `DatabaseSync` only; `sequelize` removed. |
| Persistence: `OPSPILOT_DB`; tests never touch it (1.3.0) | Pass | `resolveDbPath`; tests use `:memory:` by default. The five file-backed tests use a fresh temp directory under `os.tmpdir()`, removed afterwards, never `data/`. |
| Persistence: prepared statements | Pass | All value-carrying SQL is `prepare` with `?`. `exec` is limited to constant DDL, pragmas, and transaction control (R4). An injection test proves it. |
| Persistence: idempotent schema and seed | Pass | `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING` on every open; tested by opening 10 times. `npm run seed` is the explicit, destructive reset (FR-004a). |
| Persistence: CHECK mirrors domain | Pass | Literal CHECKs, plus a parity test over every zod enum value (R5). |
| Persistence: `data/` not committed | Pass | Already in `.gitignore`; the comment is updated. |
| Persistence: SQL behind the store interface | Pass | Tools receive `OpsStore`; no SQL outside `src/store/`. |
| Stack Exceptions: JSON store until SQLite ships | Pass, then ends | The memory mock stays for tests and the bench only. A PATCH amendment (1.3.0 to 1.3.1) removes the expired exception as part of this feature and moves its lasting clause (memory store for tests and the bench only) into the Persistence rules. |
| Security | Pass | No secrets. `.env` is never read by agents. `StoreOpenError` names the path, not file contents. |
| Workflow | Pass | `/speckit-specify` with clarifications, then this plan. |

Post-design re-check: same result. No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-sqlite-ops-store/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── ops-store.md
│   └── agent-tools.md
├── checklists/requirements.md
└── tasks.md             # Created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── schemas.ts                  # + ServiceTier, Service.tier, Incident.resolvedAt/summary, Runbook,
│   │                               #   IncidentFilter, ListIncidentsInput, GetRunbookInput, summary; .describe() on every input field
│   └── errors.ts                   # + RunbookNotFoundError, StoreOpenError; - StoreFileError
├── store/
│   ├── ops-store.ts                # NEW: OpsStore interface, formatIncidentId, incident filter helper
│   ├── ops-store-contract.ts       # NEW: shared test suite (not *.test.ts; imported by both store tests)
│   ├── in-memory-store.ts          # implements OpsStore; transitions take now; + listIncidents, getRunbook
│   ├── in-memory-store.test.ts     # runs the contract suite and keeps its pure-transition tests
│   ├── sqlite-ops-store.ts         # NEW: SqliteOpsStore, resolveDbPath, openOpsStore, row mappers
│   ├── sqlite-ops-store.test.ts    # NEW: contract on :memory: + seed, idempotence, restart, CHECKs, injection
│   ├── seed-data.ts                # + tiers, + seedRunbooks
│   ├── seed.ts                     # opens OPSPILOT_DB, reset(), prints counts
│   ├── json-file-store.ts          # DELETED
│   └── json-file-store.test.ts     # DELETED
├── agents/
│   ├── tools.ts                    # takes OpsStore; + list_incidents, get_runbook; six-rule descriptions
│   └── tools.test.ts               # runs on SqliteOpsStore(":memory:"); schema rule checks
├── index.ts                        # openOpsStore() once; StoreOpenError leads to exit 1
├── arena.ts                        # same as index.ts
└── bench.ts                        # unchanged behaviour (fresh createStore() per run); type import only
.gitignore                          # comment: SQLite database; recreate with npm run seed
package.json                        # - sequelize
README.md                           # persistence notes: OPSPILOT_DB, tools list
.specify/memory/constitution.md     # 1.3.1: remove the expired JSON-store exception
```

**Structure Decision**: Single project, as today. All persistence stays in `src/store/` (the Model
layer). The interface gets its own module so neither implementation owns it.

## Implementation Order

1. Remove `sequelize`. Domain types and errors, seed data (tiers, runbooks), `ops-store.ts`, and
   the contract suite.
2. Memory store on the new interface (contract green). Bench and agent tests still green.
3. `SqliteOpsStore` with DDL, seed, statements, and mappers (contract and SQLite tests green).
   Then composition (`index.ts`, `arena.ts`, `seed.ts`) and removal of the JSON store, so the MVP
   persists for real.
4. Tools: two new tools, six-rule descriptions, tests on `:memory:`.
5. Docs and the constitution PATCH (1.3.1).
6. Quickstart steps 1 to 3 (step 4 is the restart test). Steps 5 and 6 call the live model, so the
   user runs them (SC-004, and the bench part of SC-005).

## Complexity Tracking

No violations to justify.
