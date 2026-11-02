# Feature Specification: SQLite Ops Store

**Feature Branch**: `004-sqlite-ops-store`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Real persistence for operations: SqliteOpsStore
(src/store/sqlite-ops-store.ts) implements the existing OpsStore interface through node:sqlite
(DatabaseSync); path in OPSPILOT_DB (default ./data/opspilot.db); ':memory:' in tests. Four tables
(services, alerts, incidents, runbooks) mirroring the current domain types (incidents gain nullable
resolved_at and summary); idempotent DDL in the constructor; CHECK on every closed domain field
(tier, severity, status). Idempotent seed = the mock's Mercadinho scenario (5 services, 6 alerts: 3
firing, 3 resolved; runbooks for checkout/payments/auth). Prepared statements in every query, no
concatenated SQL. New tools: list_incidents (status open | resolved | all, default open) and
consultar_runbook (service), descriptions by the 6 rules. Composition injects SqliteOpsStore; the
in-memory mock stays for tests and the bench so scenarios are reproducible. data/ in .gitignore.
Review the descriptions in src/agents/tools.ts by the 6 rules (open_incident debt: when to use;
describe() on every field; enums). Tests on ':memory:': seed, open/list/resolve, filters and
CHECKs; the existing tool tests run on ':memory:'." The original Portuguese text is in
`docs/prompts/0054-20261102-143025.md`.

## Clarifications

### Session 2026-11-02

- Q: The request names a "Mercadinho" seed with 5 services and 6 alerts, but the mock has 6
  services and 7 alerts (4 firing, 3 resolved). Which seed? → A: The current mock, unchanged.
- Q: Services have no `tier` today. Add one or drop the CHECK? → A: Add `tier` to the Service
  domain with values `1 | 2 | 3` (1 critical, 2 important, 3 auxiliary), enforced by a CHECK.
- Q: The runbook tool is named `consultar_runbook` in the request. Keep it? → A: No; it is
  `get_runbook`, in English like the other tools.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operations survive a restart (Priority: P1)

The on-call engineer opens an incident through OpsPilot, the app restarts, and the incident is
still there with its status. Alerts, services, and incidents live in a real database file instead
of a JSON file that is rewritten on every change.

**Why this priority**: Without durable, consistent storage the copilot forgets the work of the
shift. Every other story reads or writes this data.

**Independent Test**: Open an incident against a file database, close and reopen the store, and
list incidents; the incident is returned with the same id and status.

**Acceptance Scenarios**:

1. **Given** an empty database location, **When** the store opens it, **Then** the schema and the
   seed scenario are created.
2. **Given** a database that already holds the seed and one incident, **When** the store opens it
   again, **Then** no row is duplicated and the incident is still present.
3. **Given** an open incident, **When** it is resolved, **Then** its status is `resolved` and the
   resolution time is recorded.
4. **Given** a value outside a closed domain set (for example severity `urgent`), **When** it is
   written directly to the database, **Then** the database rejects it.

---

### User Story 2 - The copilot lists incidents (Priority: P2)

The engineer asks "what incidents are open?" or "what did we resolve today?" and the copilot answers
from the incident records, filtered by status.

**Why this priority**: Today the copilot can open and resolve incidents but cannot see them, so it
cannot answer about the state of the shift or pick an id to resolve.

**Independent Test**: With two open and one resolved incident, call the listing tool with each
filter and check the counts.

**Acceptance Scenarios**:

1. **Given** two open and one resolved incident, **When** the tool is called with no status,
   **Then** only the two open incidents are returned.
2. **Given** the same data, **When** the tool is called with `resolved` or `all`, **Then** one or
   three incidents are returned.
3. **Given** a status outside `open | resolved | all`, **When** the tool is called, **Then** the
   input is rejected before reaching the store.

---

### User Story 3 - The copilot reads a runbook (Priority: P2)

The engineer asks "how do I handle the checkout alert?" and the copilot fetches the runbook for that
service and answers with its steps.

**Why this priority**: Runbooks turn the copilot from a status reader into a guide for the fix.

**Independent Test**: Call the runbook tool for `checkout-api` and for a service without a runbook;
the first returns steps, the second returns a clear "not found" message the model can act on.

**Acceptance Scenarios**:

1. **Given** the seed, **When** the runbook for the checkout, payments, or auth service is
   requested, **Then** its title and steps are returned.
2. **Given** a service with no runbook, **When** its runbook is requested, **Then** the tool
   returns a domain error text naming the services that have runbooks, and the run continues.
3. **Given** a service name that does not exist, **When** its runbook is requested, **Then** the
   tool returns a domain error text listing the known services.

---

### User Story 4 - Tool descriptions guide the model (Priority: P3)

Every agent tool, old and new, has a description that follows the project's six description rules,
so the model knows when to call it and what each argument means.

**Why this priority**: Better descriptions reduce wrong tool calls, but the feature works without
them.

**Independent Test**: Inspect each tool definition: every argument has its own description, closed
values are enumerations, and the description says when to use the tool.

**Acceptance Scenarios**:

1. **Given** the `open_incident` tool, **When** its definition is read, **Then** it states when to
   use it (an alert needs follow-up and no open incident covers it yet).
2. **Given** any tool argument, **When** its schema is read, **Then** it carries a description,
   and closed sets are enumerations rather than free text.

---

### User Story 5 - Reproducible bench and tests (Priority: P3)

The bench and the tests keep running on fresh, isolated data, so a scenario gives the same starting
state on every run and never touches the developer's database file.

**Why this priority**: Comparing strategies is only meaningful when every run starts from the same
data.

**Independent Test**: Run the bench and the test suite; the database file on disk is unchanged
afterwards.

**Acceptance Scenarios**:

1. **Given** the bench, **When** it runs a scenario, **Then** it uses a fresh in-memory store
   seeded with the same scenario.
2. **Given** the existing tool tests, **When** they run, **Then** they use an in-memory database
   and pass.

---

### Edge Cases

- The database directory does not exist yet: it is created on first open.
- The configured path points to a location that cannot be written: start-up fails with a clear
  error naming the path, not a raw driver error. It is a start-up error, not a domain error the
  model sees.
- An incident is resolved twice: the second call returns the existing "already resolved" error.
- An incident is opened for an unknown service: the existing "service not found" error is returned.
- Incident ids keep counting across restarts (no reuse of `INC-001` after a restart).
- Free text containing quotes or SQL keywords (for example a title `x'); DROP TABLE alerts;--`) is
  stored verbatim and never executed.
- The store opens a database where a seeded alert was resolved: the seed run on open does not
  reopen it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist services, alerts, incidents, and runbooks in a database file
  whose location is configurable through `OPSPILOT_DB`, defaulting to `./data/opspilot.db`.
- **FR-002**: The database-backed store MUST offer the same operations and results as the existing
  in-memory store, so tools and the bench can use either without change.
- **FR-003**: Opening the store MUST create any missing schema and MUST be safe to repeat on an
  existing database.
- **FR-004**: The seed that runs every time the store opens MUST be idempotent: opening any number
  of times leaves exactly one copy of each seeded record and never overwrites records changed after
  the seed.
- **FR-004a**: An explicit reset command (`npm run seed`) MUST return the database to the seed
  state: it removes every incident and restores every seeded record. This is destructive on
  purpose and is the only way to undo changes made after the seed.
- **FR-005**: The seed MUST be the current mock scenario (6 services; 7 alerts, 4 firing and 3
  resolved; no incidents), each service with a tier, plus runbooks for `checkout-api`,
  `payments-worker`, and `auth-service`. The database seed and the in-memory mock MUST come from
  the same source data.
- **FR-006**: Incidents MUST record an optional resolution time and an optional summary, both
  empty while the incident is open.
- **FR-007**: The database MUST reject values outside every closed domain set: alert severity,
  incident severity, alert status, incident status, and service tier (`1 | 2 | 3`).
- **FR-007a**: Services MUST carry a tier: 1 critical, 2 important, 3 auxiliary. The tier is part
  of the domain type and is validated at the boundary like the other closed fields.
- **FR-008**: Every database query MUST bind values as parameters; no query text may be built from
  input values.
- **FR-009**: The agent MUST offer a tool to list incidents by status `open | resolved | all`,
  defaulting to `open`.
- **FR-010**: The agent MUST offer a tool to read the runbook of a service, named
  `get_runbook`, taking the exact service name.
- **FR-011**: Every tool description MUST follow the six description rules: what it does, when to
  use it, a description on every argument, enumerations for closed sets, what it returns, and how
  to identify records (ids and exact service names).
- **FR-012**: The running app MUST use the database-backed store; the in-memory store MUST remain
  available for tests and the bench.
- **FR-013**: The database files MUST NOT be committed to version control.
- **FR-014**: Tests MUST use an in-memory database by default and MUST cover seeding, opening,
  listing, and resolving incidents, the status filters, and the rejection of out-of-set values.
  The existing tool tests MUST run against an in-memory database. Only tests that need a file
  (for example reopening after a restart, opening repeatedly, keeping a changed record across a
  reopen, creating a missing directory, or failing on an unwritable path) MAY use one, in a
  fresh temporary directory that is removed afterwards and never under `data/` (constitution
  1.3.0).

### Key Entities

- **Service**: a production service the team owns, identified by its unique name, with a tier
  (1 critical, 2 important, 3 auxiliary).
- **Alert**: a monitoring signal for one service, with title, severity, status (firing or
  resolved), and the time it started firing.
- **Incident**: a follow-up record for one service, with id (`INC-NNN`), title, severity, status
  (open or resolved), and, once resolved, the resolution time and an optional summary.
- **Runbook**: the response guide for one service, with a title and ordered steps.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of incidents opened before a restart are listed with the same id and status
  after it.
- **SC-002**: Opening the store 10 times in a row on the same database leaves the record counts
  equal to the seed counts.
- **SC-003**: 100% of out-of-set values for closed domain fields are rejected by the database.
- **SC-004**: Asked "which incidents are open?" and "how do I handle the checkout alert?", the
  copilot answers from the stored data in a single run, without asking the engineer for ids. This
  depends on a live model, so it is verified manually; the tools it relies on are covered by
  automated tests.
- **SC-005**: The test suite and the bench leave the developer's database file unchanged.

## Assumptions

- "The existing OpsStore interface" is the current `Store` interface; any rename is a planning
  decision and the operations stay the same.
- The JSON file store is retired as the app's persistence once this ships; existing `data/db.json`
  contents are not migrated (they are demo data reseeded from the mock).
- Runbook steps are plain ordered text; runbooks are read-only for the agent in this feature.
- `list_incidents` returns incidents ordered by id; the resolution summary is optional and the
  resolve tool MAY accept it.
- Node.js 22.13 or newer is required, per the constitution, so the built-in SQLite module needs no
  flag.
