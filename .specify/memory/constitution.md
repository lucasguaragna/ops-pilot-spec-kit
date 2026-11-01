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

- Node.js 22 LTS and TypeScript ESM with `strict: true`
- LangChain and LangGraph agent running on OpenRouter
- Express, with MySQL through Sequelize
- `zod` for validation; `node:test` through `tsx` for tests
- Secrets MUST NOT be committed, and `.env` MUST NOT be read by agents
- New dependencies MUST NOT replace this stack without a constitution amendment

## Development Workflow

Relevant changes MUST follow this order, with specs versioned in the repository:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

## Governance

This constitution overrides other project practices. `CLAUDE.md` holds runtime guidance and MUST
stay consistent with it. Every plan and review MUST verify compliance.

Amendments MUST be documented here and follow semantic versioning: MAJOR for removed or redefined
principles, MINOR for new principles or sections, and PATCH for wording fixes.

**Version**: 1.0.0 | **Ratified**: 2026-11-01 | **Last Amended**: 2026-11-01
