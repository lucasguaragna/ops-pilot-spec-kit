# Implementation Plan: Reasoning Nucleus

**Branch**: `001-reasoning-nucleus` (name only; work is on `main`) | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-reasoning-nucleus/spec.md`

## Summary

Build two reasoning strategies, ReAct and Plan-and-Execute, behind one `ReasoningStrategy`
interface. Both use one model factory and three tools over a seeded in-memory store, return a typed
trace with metrics, and are compared through a CLI arena. Store and trace logic are pure and tested
without network. See [research.md](research.md) for decisions.

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js (see Constitution Check)

**Primary Dependencies**: `langchain` 1.6 (added for `createAgent`), `@langchain/langgraph` 1.6,
`@langchain/openai` 1.8, `@langchain/core` 1.3, `zod` 4

**Storage**: `data/db.json` for runs, memory for tests. MySQL is deferred (see Complexity Tracking).

**Testing**: `node:test` through `tsx`, using a fake chat model and no network

**Target Platform**: Local CLI

**Project Type**: CLI over a library of strategies

**Performance Goals**: None beyond iteration limits; latency is measured, not targeted

**Constraints**: Temperature 0, at most 8 Plan-and-Execute steps, secrets never printed

**Scale/Scope**: 3 tools, 2 strategies, 5 services, 6 alerts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | Model: `src/domain`, `src/store`. Service: `src/agents`. Controller: `src/arena.ts`. |
| II. Validated Boundaries | Pass | zod validates tool input, CLI flags, environment, and planner output. |
| III. Domain Errors at the Edge | Pass | Store throws domain classes; the arena turns them into CLI output. Tools return them to the model as text. |
| IV. Pure Functions | Pass | Store transitions, message-to-trace mapping, and formatting are pure. State and LLM calls stay in thin wrappers. |
| V. Tested and Green | Pass | Store, trace, and LLM counter tests; `typecheck` and `test` stay green. |
| Stack: MySQL through Sequelize | Exception | Deferred by user choice in the spec. See Complexity Tracking. |
| Stack: Node.js 22 LTS | Open | This machine runs v24.15.0. Nothing here needs v24; resolve outside this feature. |
| Security | Pass | Key is read from the environment and never logged; `.env` loads through Node's native flag. |
| Workflow | Pass | This plan follows `/speckit-specify`. |

Post-design re-check: same result. Design added no new violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-reasoning-nucleus/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── arena-cli.md
│   ├── reasoning-strategy.md
│   └── tools.md
└── tasks.md             # Created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── arena.ts                     # Controller: CLI flags, runs strategies, prints results
├── domain/
│   ├── errors.ts                # Domain and configuration error classes
│   ├── schemas.ts               # zod schemas for entities and tool input
│   └── types.ts                 # Trace, metrics, RunResult, ReasoningStrategy
├── store/
│   ├── in-memory-store.ts       # Pure transitions plus a thin stateful wrapper
│   ├── in-memory-store.test.ts
│   ├── json-file-store.ts       # data/db.json backend, validated on load
│   ├── json-file-store.test.ts
│   ├── seed-data.ts             # 5 services, 6 alerts
│   └── seed.ts                  # Seed command, writes data/db.json
├── trace/
│   ├── format.ts                # Pure trace and metrics text formatting
│   ├── format.test.ts
│   ├── from-messages.ts         # Pure message-to-trace mapping
│   └── from-messages.test.ts
├── agents/
│   ├── model.ts                 # Single model factory
│   ├── llm-counter.ts           # Callback that counts LLM calls
│   ├── run-outcome.ts           # Pure helpers mapping thrown errors to RunResult fields
│   ├── tools.ts                 # list_alerts, open_incident, resolve_incident
│   ├── react.ts                 # ReAct strategy
│   ├── plan-and-execute.ts      # Plan-and-Execute graph
│   └── *.test.ts                # One test file per module above, except run-outcome.ts
└── testing/
    └── scripted-chat-model.ts   # Test-only fake chat model that replays scripted turns
```

`src/arena.test.ts` covers flag parsing.

`src/index.ts` stays empty. `package.json` gains a `seed` script, and `arena` gains `.env` loading.

**Structure Decision**: Single project. File paths named in the spec input are kept. The `bench`
script target, `src/bench.ts`, stays out of scope.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| MySQL through Sequelize deferred | User chose an in-memory store for this feature; no database is available locally | Adding MySQL now would make store tests need a database. All store access goes through tools, so a later feature can swap it. |
