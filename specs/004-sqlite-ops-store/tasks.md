---

description: "Task list for the SQLite Ops Store feature"
---

# Tasks: SQLite Ops Store

**Input**: Design documents from `specs/004-sqlite-ops-store/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/ops-store.md](contracts/ops-store.md),
[contracts/agent-tools.md](contracts/agent-tools.md), [quickstart.md](quickstart.md)

**Tests**: Requested. FR-014 asks for tests, and the constitution says new logic ships with a test.
Within each story, the test task comes first and must fail before the implementation task.

**Organization**: Tasks are grouped by user story, so each story can be built and checked on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1 to US5)
- Every description names the exact file path

## Path Conventions

Single project. Source in `src/`, tests next to the code as `*.test.ts`, run with `node:test`
through `tsx`. Gates: `npm run typecheck` and `npm test`.

---

## Phase 1: Setup

**Purpose**: Drop what the feature retires before any code changes.

- [X] T001 Remove the unused `sequelize` dependency from `package.json` and run `npm install` so
  `package-lock.json` matches (R12).
- [X] T002 [P] In `.gitignore`, replace the comment `# Runtime JSON database; recreate with npm run seed`
  above `data/` with `# SQLite database (OPSPILOT_DB, default ./data/opspilot.db); recreate with npm run seed`.
  Keep the `data/` line (FR-013).

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: New domain types, the `OpsStore` interface, the shared contract suite, and the memory
store on that interface. Every story depends on this phase.

**⚠️ CRITICAL**: No user story work starts until this phase is done and `npm run typecheck` and
`npm test` are green.

- [X] T003 [P] Extend `src/domain/schemas.ts` per [data-model.md](data-model.md):
  - add `ServiceTier = z.union([z.literal(1), z.literal(2), z.literal(3)])` (1 critical,
    2 important, 3 auxiliary) and its type;
  - add `tier: ServiceTier` to `Service`;
  - add to `Incident` `resolvedAt: z.iso.datetime().nullable()` and
    `summary: z.string().min(1).nullable()` ("Both are `null` while `open`");
  - add `Runbook = z.object({ service: z.string(), title: z.string(), steps: z.array(z.string().min(1)).min(1) })`
    and its type;
  - add `IncidentFilter = z.enum(["open", "resolved", "all"])` and its type;
  - add `ListIncidentsInput = z.object({ status: IncidentFilter.default("open") })` and
    `GetRunbookInput = z.object({ service: z.string().trim().min(1) })`, each with a `.describe()`
    on its field written to the six rules in [contracts/agent-tools.md](contracts/agent-tools.md);
  - add `summary: z.string().trim().min(1).optional()` to `ResolveIncidentInput`, with a
    `.describe()` ("what fixed it");
  - export `type ResolveIncidentInput`.
- [X] T004 [P] In `src/domain/errors.ts`, add `RunbookNotFoundError extends DomainError` with
  constructor `(service: string, servicesWithRunbooks: readonly string[])` and a message that names
  the service and lists the services that have a runbook. Also add `StoreOpenError extends Error`
  (not a DomainError) with constructor `(path: string, reason: string)` and a message naming the
  path and the reason, never file contents. Leave `StoreFileError` in place for now (it goes in
  T017).
- [X] T005 Update `src/store/seed-data.ts` (after T003):
  - give every service its tier, keeping the array order: `checkout-api` 1, `payments-worker` 1,
    `auth-service` 1, `search-api` 2, `catalog-api` 2, `notification-service` 3;
  - keep `ALT-001` to `ALT-007` unchanged (4 firing, 3 resolved);
  - add `export const seedRunbooks: readonly Runbook[]` for `checkout-api`, `payments-worker`, and
    `auth-service` only. Each has a title and 3 to 5 ordered steps tied to its alerts: latency and
    pod restarts for checkout, queue backlog for payments, login error rate for auth.
- [X] T006 Create `src/store/ops-store.ts` (after T003 and T004):
  - move `StoreState` here from `src/store/in-memory-store.ts` and add
    `runbooks: readonly Runbook[]`;
  - define `export interface OpsStore` exactly as in [contracts/ops-store.md](contracts/ops-store.md):
    `getState`, `listAlerts`, `listIncidents`, `getRunbook`, `openIncident`,
    `resolveIncident(input: ResolveIncidentInput)`, `reset`;
  - add the pure `formatIncidentId(n: number): string`, which returns `INC-` plus `n` padded to
    3 digits;
  - add the pure `filterIncidents(incidents, filter: IncidentFilter): Incident[]`, which returns
    every incident for `all` and otherwise those whose status equals the filter;
  - add the pure `runbookFor(services, runbooks, service): Runbook`, which throws
    `ServiceNotFoundError` for an unknown service and `RunbookNotFoundError` (listing services with
    runbooks) for a known service without one.

  Re-export `StoreState` from `src/store/in-memory-store.ts` so existing imports keep working.
- [X] T007 Create the shared contract suite `src/store/ops-store-contract.ts` (after T005 and T006).
  Use the name `ops-store-contract.ts`, not `*.test.ts`, so the runner does not pick it up alone.
  - Export `runOpsStoreContract(label: string, makeStore: (now: () => string) => OpsStore)`. It
    declares a `describe` block with one `it` per row of "Behaviour both stores share" in
    [contracts/ops-store.md](contracts/ops-store.md).
  - Inject a fixed clock (`() => "2026-11-02T12:00:00.000Z"`).
  - Assert the exact ids `INC-001` and `INC-002`, the firing ids `ALT-001`, `ALT-002`, `ALT-003`,
    `ALT-007`, the filter counts 2, 1, and 3, and the runbook errors naming
    `checkout-api, payments-worker, auth-service`.
  - Store the injection title `x'); DROP TABLE alerts;--` and assert it comes back verbatim.
  - Check that `reset()` gives a state deep-equal to `createInitialState()`.
- [X] T008 Rework `src/store/in-memory-store.ts` to implement `OpsStore` (after T007):
  - `createInitialState()` includes `seedRunbooks`;
  - `openIncident(state, input)` builds ids with `formatIncidentId` and sets
    `resolvedAt: null, summary: null`;
  - `resolveIncident(state, { id, summary }, now: string)` sets `status: "resolved"`,
    `resolvedAt: now`, `summary: summary ?? null`, and keeps the existing errors;
  - add `listIncidents` through `filterIncidents`, and `getRunbook` through `runbookFor`;
  - change the factory to `createStore(options?: { backend?: StoreBackend; initial?: StoreState; now?: () => string })`,
    where `now` defaults to `() => new Date().toISOString()`. Keep `StoreBackend` and
    `createMemoryBackend` until T017 so the JSON store still compiles.

  In the same task, update the callers so the build stays green:
  - `src/index.ts` and `src/arena.ts`: `createStore({ backend: createJsonFileBackend() })`;
  - `src/agents/tools.ts`: `import type { OpsStore }` and
    `store.resolveIncident({ id, summary })`;
  - `src/bench.test.ts` and `src/store/in-memory-store.test.ts`: the pure `resolveIncident` now
    takes `({ id }, now)`;
  - `src/store/json-file-store.ts`, if its types moved.
- [X] T009 In `src/store/in-memory-store.test.ts`, call
  `runOpsStoreContract("memory", (now) => createStore({ now }))` and keep the existing
  pure-transition tests, adjusted for `now`, `resolvedAt`, and `summary` (after T008). Run
  `npm run typecheck && npm test`: all green.

**Checkpoint**: The interface, domain, and memory store are ready. The bench and agent tests are
still green.

---

## Phase 3: User Story 1 - Operations survive a restart (Priority: P1) 🎯 MVP

**Goal**: The app persists services, alerts, incidents, and runbooks in a SQLite file at
`OPSPILOT_DB`. The schema and seed are idempotent, CHECKs reject out-of-set values, and the JSON
store is gone.

**Independent Test**: Open an incident on a file database, close and reopen the store, and list
incidents. It comes back with the same id and status, and the next id is `INC-002`.

### Tests for User Story 1

- [X] T010 [P] [US1] Create `src/store/sqlite-ops-store.test.ts` (it fails until T011–T014 exist):
  - **Contract**: `runOpsStoreContract("sqlite", (now) => new SqliteOpsStore(":memory:", { now }))`.
  - **CHECKs on `:memory:`**: run the exported `SCHEMA` on a raw `new DatabaseSync(":memory:")` and
    insert parent rows through prepared statements.
    - Each of these MUST throw `/CHECK constraint failed/`: alert severity `urgent`, incident
      severity `urgent`, alert status `closed`, incident status `closed`, tier `4`, and an `open`
      incident with a non-null `resolved_at`.
    - Every value of `Severity.options`, `AlertStatus.options`, `IncidentStatus.options`, and tiers
      1, 2, 3 MUST be accepted (R5 parity).
  - **File tests**, in a `mkdtempSync(join(tmpdir(), "opspilot-"))` directory and never in `data/`.
    Remove it in `after` with `rmSync(dir, { recursive: true, force: true })` (constitution 1.3.0):
    - open 10 times, then expect counts services 6, alerts 7, runbooks 3, incidents 0 (SC-002);
    - restart: open an incident, `close()`, reopen, expect the same id and status, then `INC-002`
      next (SC-001);
    - a seeded alert set to `resolved` with a raw prepared `UPDATE` is still `resolved` after
      reopening (FR-004).
  - **`resolveDbPath`**: unset gives `./data/opspilot.db`; `""` and `"  "` give the default;
    `" ./x.db "` gives `./x.db`.
  - **`openOpsStore`**: a missing nested directory is created; a path under a regular file (for
    example `<tmpfile>/x.db`) throws `StoreOpenError` whose message contains the path.
  - **Closed store**: after `close()`, `listAlerts("all")` throws.

### Implementation for User Story 1

- [X] T011 [US1] In `src/store/sqlite-ops-store.ts`, write and export the constant `SCHEMA` (R5). It
  holds four `CREATE TABLE IF NOT EXISTS ... STRICT` statements with the constraints copied from
  [data-model.md](data-model.md):
  - `services(name TEXT PRIMARY KEY CHECK (length(name) > 0), tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)))`;
  - `alerts`, with `severity ... CHECK (severity IN ('low', 'medium', 'high', 'critical'))`,
    `status ... CHECK (status IN ('firing', 'resolved'))`, and
    `service TEXT NOT NULL REFERENCES services(name)`;
  - `incidents`, with `service TEXT NOT NULL REFERENCES services(name)`,
    `severity ... CHECK (severity IN ('low', 'medium', 'high', 'critical'))` (same CHECK as alerts),
    `status ... CHECK (status IN ('open', 'resolved'))`, nullable `resolved_at`
    and `summary`, and the table CHECK
    `(status = 'open' AND resolved_at IS NULL AND summary IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL)`;
  - `runbooks(service TEXT PRIMARY KEY REFERENCES services(name), title TEXT NOT NULL CHECK (length(title) > 0), steps TEXT NOT NULL CHECK (json_valid(steps)))`.

  The CHECK value lists are literal text and are never built from the zod enums.
- [X] T012 [US1] Add the class `SqliteOpsStore implements OpsStore` to
  `src/store/sqlite-ops-store.ts` (after T011):
  - **Constructor** `(path: string, options?: { now?: () => string })`:
    - open `new DatabaseSync(path)` with no options;
    - `exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")` (R1);
    - `exec(SCHEMA)`;
    - prepare every statement once into private fields;
    - run the seed.
  - **`transaction(fn)`**: a private helper that runs `BEGIN`, `fn`, then `COMMIT`, or `ROLLBACK`
    and rethrow on error.
  - **Seed**: one transaction of
    `INSERT INTO ... VALUES (?, ...) ON CONFLICT DO NOTHING` for `seedServices`, `seedAlerts`, and
    `seedRunbooks`, with `steps` passed as `JSON.stringify(steps)` (R7).
  - **`close()`** on the class only.

  `exec` takes only constant text. Every value goes through `prepare` with `?` (FR-008).
- [X] T013 [US1] Add the reads to `src/store/sqlite-ops-store.ts` (after T012):
  - **Mappers**: the pure row mappers `toService`, `toAlert`, `toIncident`, and `toRunbook` map
    `fired_at` to `firedAt` and `resolved_at` to `resolvedAt`, `JSON.parse` the runbook `steps`,
    and parse each result with the domain zod schema.
  - **Order**:
    - services by `rowid`;
    - alerts by `id`;
    - incidents by `CAST(substr(id, 5) AS INTEGER)`.
  - **Methods**:
    - `listAlerts(filter)`, through the same filter rule as the memory store;
    - `listIncidents(filter)`, through `filterIncidents`;
    - `getRunbook(service)`, through `runbookFor` on the loaded services and runbooks;
    - `getState()`, with `nextIncidentNumber` from
      `SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 0) + 1 FROM incidents`.
- [X] T014 [US1] Add the writes to `src/store/sqlite-ops-store.ts` (after T013):
  - **`openIncident(input)`**: inside `transaction`, throw `ServiceNotFoundError` (with the known
    services in `rowid` order) when the service is missing. Otherwise compute
    `MAX + 1`, `formatIncidentId(n)`, and insert with `status 'open'` and null
    `resolved_at`/`summary` (R6).
  - **`resolveIncident({ id, summary })`**:
    - unknown id: `IncidentNotFoundError`;
    - already resolved: `IncidentAlreadyResolvedError`;
    - otherwise `UPDATE` with `status 'resolved'`, `resolved_at = now()`, and
      `summary = summary ?? null`, then return the mapped row.
  - **`reset()`**: inside `transaction`, delete from incidents, runbooks, alerts, then services,
    and reseed.
- [X] T015 [US1] Add the construction helpers to `src/store/sqlite-ops-store.ts` (after T012):
  - the pure `resolveDbPath(env: NodeJS.ProcessEnv): string`. It parses `env.OPSPILOT_DB` with
    `z.string().trim().min(1).optional().catch(undefined)` (Principle II) and returns the parsed
    value, or `./data/opspilot.db` when it is unset, empty, or blank;
  - `openOpsStore(env = process.env, options?)`. Inside one `try`, it calls
    `mkdirSync(dirname(path), { recursive: true })` unless the path is `:memory:` and then
    `new SqliteOpsStore(path, options)`. The `catch` wraps any error from either call in
    `StoreOpenError(path, reason)` (R9), so a path under a regular file (ENOTDIR from `mkdirSync`)
    also gives `StoreOpenError`.

  Then run `npm test`: T010 is green.
- [X] T016 [US1] Rewire the entry points (after T015):
  - **`src/index.ts`**: open the store once at startup with `openOpsStore()`. Catch
    `StoreOpenError`, print its message with `console.error`, and `process.exit(1)`.
    `createDependencies` reuses that one store with `createTools(store)` (R10).
  - **`src/arena.ts`**: same change.
  - **`src/store/seed.ts`**: this is the explicit, destructive reset of FR-004a, not the
    idempotent open-time seed of FR-004. Rewrite it to `openOpsStore()`, call `reset()`, and print
    the counts of services, alerts, runbooks, and incidents from `getState()`. Then `close()`. Add a
    top-of-file comment saying it wipes incidents and restores seeded records. Catch
    `StoreOpenError` as `index.ts` does (`console.error` and `process.exit(1)`), so a bad path
    never prints a raw stack trace.
- [X] T017 [US1] Retire the JSON store (after T016):
  - delete `src/store/json-file-store.ts` and `src/store/json-file-store.test.ts`;
  - remove `StoreFileError` from `src/domain/errors.ts`;
  - remove `StoreBackend`, `createMemoryBackend`, and the `backend` option from
    `src/store/in-memory-store.ts`, keeping state in a closure;
  - `createStore(options?: { initial?: StoreState; now?: () => string })` with no arguments still
    works.

  `grep -rn "json-file-store\|StoreFileError\|createMemoryBackend" src` returns nothing. Run
  `npm run typecheck && npm test`: green.

**Checkpoint**: US1 is done. Run [quickstart.md](quickstart.md) steps 2 and 3 (counts `6|7|3|0`,
CHECK failures).

---

## Phase 4: User Story 2 - The copilot lists incidents (Priority: P2)

**Goal**: The agent can list incidents by `open | resolved | all` (default `open`) and resolve one
with an optional summary.

**Independent Test**: With two open incidents and one resolved, call `list_incidents` with no
status, with `resolved`, and with `all`. The counts are 2, 1, and 3.

### Tests for User Story 2

- [X] T018 [P] [US2] Add a `describe("list_incidents")` block to `src/agents/tools.test.ts` on
  `new SqliteOpsStore(":memory:")`. Destructure `[, openIncident, resolveIncident, listIncidents]`
  from `createTools(store)`.
  - Set up 2 open incidents and 1 resolved.
  - `{}` returns the 2 open ones (default `open`); `resolved` returns 1; `all` returns 3, ordered
    by id.
  - `{ status: "closed" }` is rejected by `invoke` before the store is called, and `getState()` is
    unchanged.
  - `resolve_incident` with `summary: "Rolled back deploy"` returns `summary` and a non-null
    `resolvedAt`.

### Implementation for User Story 2

- [X] T019 [US2] Add the `list_incidents` tool to `src/agents/tools.ts`, with schema
  `ListIncidentsInput`. It calls `toToolText(() => store.listIncidents(status))` and is appended at
  index 3 of the returned tuple. Its description follows the six rules, using the `list_incidents`
  row of [contracts/agent-tools.md](contracts/agent-tools.md):
  - what it does;
  - when to use it: the engineer asks about incidents or the shift, before `open_incident` to
    avoid duplicates, and to find an id for `resolve_incident`;
  - it returns `Incident[]` ordered by id;
  - ids are `INC-NNN`.

  Run `npm test`: T018 is green.

**Checkpoint**: US1 and US2 work.

---

## Phase 5: User Story 3 - The copilot reads a runbook (Priority: P2)

**Goal**: The agent fetches the runbook of a service and answers with its steps. A missing runbook
or an unknown service comes back as actionable error text.

**Independent Test**: `get_runbook` for `checkout-api` returns its steps. For `search-api` it
returns text naming the services that have runbooks.

### Tests for User Story 3

- [X] T020 [P] [US3] Add a `describe("get_runbook")` block to `src/agents/tools.test.ts` on
  `new SqliteOpsStore(":memory:")`, taking tuple index 4.
  - `checkout-api`, `payments-worker`, and `auth-service` each return a title and a non-empty
    `steps` array.
  - `search-api` returns text starting `Error:` that names `checkout-api`, `payments-worker`, and
    `auth-service`.
  - `nope` returns text starting `Error:` that lists the known services.

### Implementation for User Story 3

- [X] T021 [US3] Add the `get_runbook` tool to `src/agents/tools.ts`, with schema `GetRunbookInput`.
  It calls `toToolText(() => store.getRunbook(service))` and is appended at index 4. Its
  description follows the six rules, using the `get_runbook` row of
  [contracts/agent-tools.md](contracts/agent-tools.md):
  - when to use it: the engineer asks how to handle or fix an alert or service;
  - it returns `{ service, title, steps[] }`;
  - the two error texts;
  - the service is the exact name from `list_alerts`.

  Run `npm test`: T020 is green.

**Checkpoint**: The copilot can list incidents and read runbooks.

---

## Phase 6: User Story 4 - Tool descriptions guide the model (Priority: P3)

**Goal**: All five tools meet the six description rules, and the schema rules are checked by a
test.

**Independent Test**: The schema-walk test passes. Every field has a description, `status` and
`severity` are `ZodEnum`, and the `open_incident` description mentions `list_incidents`.

### Tests for User Story 4

- [X] T022 [P] [US4] Add a `describe("tool definitions")` block to `src/agents/tools.test.ts`:
  - the tool names are exactly
    `["list_alerts", "open_incident", "resolve_incident", "list_incidents", "get_runbook"]`, in
    that order;
  - for each tool, every key of `schema.shape` has a non-empty description. Read `.description`,
    unwrapping `ZodDefault` and `ZodOptional` if the description sits on the inner type;
  - every `status` and `severity` field is a `ZodEnum` after unwrapping the default;
  - the `open_incident` description includes `list_incidents`;
  - rule 6 spot checks: the `resolve_incident` and `list_incidents` descriptions include `INC-NNN`,
    and the `open_incident` and `get_runbook` descriptions include `list_alerts` (where exact
    service names come from).

  It fails until T023 and T024 are done.

### Implementation for User Story 4

- [X] T023 [US4] In `src/domain/schemas.ts`, add `.describe()` to every existing input field:
  - `ListAlertsInput.status`: `firing | resolved | all`, default `firing`;
  - `OpenIncidentInput.title`: short summary;
  - `OpenIncidentInput.service`: the exact name from `list_alerts`;
  - `OpenIncidentInput.severity`: name the values and the mapping sev1 `critical`, sev2 `high`,
    sev3 `medium`, sev4 `low`;
  - `ResolveIncidentInput.id`: `INC-NNN` from `list_incidents`.
- [X] T024 [US4] In `src/agents/tools.ts`, rewrite the `list_alerts`, `open_incident`, and
  `resolve_incident` descriptions to the six rules, following their rows in
  [contracts/agent-tools.md](contracts/agent-tools.md).
  - `open_incident` must say to use it only when an alert needs follow-up **and** `list_incidents`
    shows no open incident for that service and problem, and never for questions or status checks.
  - Re-read the `list_incidents` and `get_runbook` descriptions against rules 1, 2, 5, and 6.

  Run `npm test`: T022 is green.

**Checkpoint**: All tools are self-describing.

---

## Phase 7: User Story 5 - Reproducible bench and tests (Priority: P3)

**Goal**: The tool tests run on an in-memory database. The bench keeps a fresh memory store per run
and never touches `data/`.

**Independent Test**: Run `npm test` and `npm run bench`. The `shasum` of `data/opspilot.db` is the
same before and after.

- [X] T025 [US5] In `src/agents/tools.test.ts`, switch the existing cases (list alerts, open
  incident, resolve, the unknown-service and already-resolved errors) from `createStore()` to
  `new SqliteOpsStore(":memory:")`, one per test, closed in `afterEach` (FR-014).
- [X] T026 [P] [US5] Check that `src/bench.ts` builds `createStore()` inside the per-run loop and
  never imports `sqlite-ops-store` or `openOpsStore`. Change any `Store` type import to `OpsStore`.
  The judge's use of `getState()` must compile against the new `Incident` fields.
- [X] T027 [US5] Run `grep -rn "data/opspilot" src --include="*.test.ts"`. The only match should be
  the expected value of the `resolveDbPath` default assertion in
  `src/store/sqlite-ops-store.test.ts`. Also check by reading that every `openOpsStore` call in
  tests passes an explicit env whose `OPSPILOT_DB` points inside the `mkdtemp` directory, never
  `process.env` (SC-005). [quickstart.md](quickstart.md) step 6 runs the bench against the live
  model (it needs the `.env` key and spends tokens), so the user runs it and confirms the two
  hashes are equal; the agent does not.

**Checkpoint**: All five stories are done.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T028 [P] Update `README.md`:
  - persistence is SQLite at `OPSPILOT_DB`, default `./data/opspilot.db`;
  - `npm run seed` resets the database to the seed and deletes every incident (destructive,
    FR-004a); opening the app only adds missing seed rows;
  - Node 22.13 or newer;
  - the tool list now has five tools;
  - remove every mention of `data/db.json` and the JSON store.
- [X] T029 [P] Amend `.specify/memory/constitution.md` to 1.3.1 (PATCH; the exception expired by
  its own terms, so no rule changes):
  - remove the expired Stack Exception for the JSON file store, and the now-empty Stack Exceptions
    section;
  - keep the part of the exception that outlives it by moving it into the Persistence rules as its
    own bullet: "The in-memory store MAY be used only by tests and the bench, where scenarios must
    be reproducible." This restates existing text, so the bump stays PATCH;
  - set Last Amended to the implementation date;
  - replace the Sync Impact Report comment (1.3.0 to 1.3.1, the exception removed).
- [X] T030 [P] Audit SQL safety. In `src/store/sqlite-ops-store.ts`,
  `grep -n '\${' src/store/sqlite-ops-store.ts` shows no interpolation inside SQL text, and
  `grep -rln "prepare(\|DatabaseSync" src` lists only files in `src/store/` (FR-008, Principle I).
- [X] T031 Run `npm run typecheck && npm test` (green). Then run [quickstart.md](quickstart.md)
  steps 1 to 3; step 4 is covered by the restart test in `npm test`. Steps 5 and 6 call the live
  model and need the `.env` key, so the user runs them: step 5 is the manual check of SC-004 and
  step 6 the bench part of SC-005 (the agent never reads `.env` and does not spend tokens
  unasked). Finally, `rm -f ./data/qs.db`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. Blocks every story.
- **US1 (Phase 3)**: after Foundational. US2, US3, US4, and US5 use `SqliteOpsStore(":memory:")`
  in their tests, so they start after T015.
- **US2 (Phase 4)** and **US3 (Phase 5)**: after US1. Both edit `src/agents/tools.ts` and
  `src/agents/tools.test.ts`, so run them one after the other (US2 first, which keeps the tuple
  order).
- **US4 (Phase 6)**: after US2 and US3, because its test checks all five tools.
- **US5 (Phase 7)**: after US1. T025 touches `tools.test.ts`, so do it after US4. T026 can run any
  time after T009.
- **Polish (Phase 8)**: after all stories.

### Within each phase

- The test task comes before the implementation task, and must fail first.
- `sqlite-ops-store.ts`: T011, then T012, then T013 and T014, then T015 (same file, in order).
- T017 (delete the JSON store) runs only after T016 has rewired every caller.

### Story completion order

```text
Setup -> Foundational -> US1 (MVP) -> US2 -> US3 -> US4 -> US5 -> Polish
```

---

## Parallel Examples

```text
# Phase 1
T001 package.json  |  T002 .gitignore

# Phase 2 (start)
T003 src/domain/schemas.ts  |  T004 src/domain/errors.ts

# Phase 3: write the failing tests while reading the DDL spec
T010 src/store/sqlite-ops-store.test.ts  |  T011 SCHEMA in src/store/sqlite-ops-store.ts

# Phase 7 and Polish
T026 src/bench.ts  |  T028 README.md  |  T029 constitution  |  T030 SQL audit
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 and Phase 2, with the contract suite green on the memory store.
2. Phase 3: `SqliteOpsStore`, entry points, and the JSON store retired.
3. **Stop and validate**: quickstart steps 2 and 3, plus the restart test. The app now persists
   for real.

### Incremental delivery

1. US1: persistence (MVP).
2. US2: `list_incidents`, so the copilot sees the shift.
3. US3: `get_runbook`, so the copilot guides the fix.
4. US4: the six-rule descriptions, so there are fewer wrong tool calls.
5. US5: the isolation checks, for a reproducible bench.

Each step leaves `npm run typecheck` and `npm test` green.

---

## Notes

- `[P]` means a different file with no unfinished dependency.
- Never read `.env`. Never commit `data/` or any `*.db` file.
- Commit after each checkpoint only when the user asks.
- Write runbook text and tool descriptions in English.
