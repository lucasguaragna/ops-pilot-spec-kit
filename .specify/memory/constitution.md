<!--
Sync Impact Report
- Version: 1.3.0 -> 1.3.1 (PATCH: the JSON file store exception expired when the SQLite feature
  shipped; no rule changes)
- Modified: Stack and Security > Persistence rules gains the bullet "The in-memory store MAY be
  used only by tests and the bench", which restates the part of the exception that outlives it
- Added sections: none
- Removed sections: Stack Exceptions (its only entry expired)
- Templates: no change needed
-->

# OpsPilot Constitution

## Core Principles

### I. Layered MVC

Code MUST follow the Model, Service, Controller layers. Each layer MUST call only the layer
directly below it.

### II. Validated Boundaries

All external input and output at HTTP and CLI boundaries MUST be validated with `zod`.

### III. Domain Errors at the Edge

Domain errors MUST be classes. They MUST be translated into HTTP or CLI output only at the edge.

### IV. Pure Functions

Logic MUST be written as pure functions. Side effects such as database, network, and LLM calls
MUST stay at the edges.

### V. Tested and Green (NON-NEGOTIABLE)

New logic MUST ship with a test. `npm run typecheck` and `npm test` MUST pass before work is done.

## Stack and Security

- Node.js 22.13 or newer (22 LTS is the baseline) and TypeScript ESM with `strict: true`
- LangChain and LangGraph agent running on OpenRouter
- Express, with SQLite through the built-in `node:sqlite` module (`DatabaseSync`); no ORM and no
  external database server
- `zod` for validation; `node:test` through `tsx` for tests
- Secrets MUST NOT be committed, and `.env` MUST NOT be read by agents
- New dependencies MUST NOT replace this stack without a constitution amendment

### Persistence rules

- The database file path MUST come from `OPSPILOT_DB` (default `./data/opspilot.db`).
- Tests MUST NOT open, create, or change the database at `OPSPILOT_DB` or anything under `data/`.
  Tests MUST use `":memory:"` by default. A test MAY use a database file only when the behaviour
  under test needs one (for example reopening after a restart, or creating a missing directory).
  That file MUST live in a fresh directory under the OS temporary directory, and the test MUST
  remove the directory when it finishes.
- Every query MUST use a prepared statement with bound parameters. SQL MUST NOT be built by string
  concatenation or interpolation of values.
- Schema creation and seeding MUST be idempotent, so opening an existing database is safe.
- Closed domain fields (enums such as tier, severity, status) MUST be enforced with `CHECK`
  constraints that mirror the domain types.
- Database files (`data/`) MUST NOT be committed.
- The in-memory store MAY be used only by tests and the bench, where scenarios must be
  reproducible.
- Database access MUST stay behind the store interface in the Model layer, so services and agent
  tools never see SQL.

## Development Workflow

Relevant changes MUST follow this order, with specs versioned in the repository:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

## Governance

This constitution overrides other project practices. `CLAUDE.md` holds runtime guidance and MUST
stay consistent with it. Every plan and review MUST verify compliance.

Amendments MUST be documented here and follow semantic versioning: MAJOR for removed or redefined
principles, MINOR for new principles or sections, and PATCH for wording fixes.

**Version**: 1.3.1 | **Ratified**: 2026-11-01 | **Last Amended**: 2026-11-03
