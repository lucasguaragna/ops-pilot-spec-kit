<!--
Sync Impact Report
- Version: 1.0.0 -> 1.1.0 (MINOR: new "Stack Exceptions" section; Node.js rule widened)
- Modified: Stack and Security (Node.js 22 LTS -> Node.js 22.9 or newer)
- Added: Stack Exceptions (MySQL through Sequelize deferred)
- Templates: plan-template.md, spec-template.md, tasks-template.md need no change
- Runtime guidance: CLAUDE.md Stack section updated
- Follow-up: remove the exception when the MySQL feature ships
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

- Node.js 22.9 or newer (22 LTS is the baseline) and TypeScript ESM with `strict: true`
- LangChain and LangGraph agent running on OpenRouter
- Express, with MySQL through Sequelize
- `zod` for validation; `node:test` through `tsx` for tests
- Secrets MUST NOT be committed, and `.env` MUST NOT be read by agents
- New dependencies MUST NOT replace this stack without a constitution amendment

## Stack Exceptions

- **MySQL through Sequelize is deferred.** Until a feature introduces it, data lives in the JSON
  file store (`data/db.json`, memory in tests) behind the Model layer. New features MAY use and
  extend that store. The store MUST stay behind Model functions so the later move to Sequelize
  changes only that layer. This exception ends when the MySQL feature ships.

## Development Workflow

Relevant changes MUST follow this order, with specs versioned in the repository:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

## Governance

This constitution overrides other project practices. `CLAUDE.md` holds runtime guidance and MUST
stay consistent with it. Every plan and review MUST verify compliance.

Amendments MUST be documented here and follow semantic versioning: MAJOR for removed or redefined
principles, MINOR for new principles or sections, and PATCH for wording fixes.

**Version**: 1.1.0 | **Ratified**: 2026-11-01 | **Last Amended**: 2026-11-02
