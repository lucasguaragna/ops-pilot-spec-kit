# Implementation Plan: Reflection Layer

**Branch**: `002-reflection-layer` (name only; work is on `main`) | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-reflection-layer/spec.md`

## Summary

Add `withReflection(strategy, { model, maxReflections })`, a decorator that returns a
`ReasoningStrategy` named `reflect:<base>`. It runs the base strategy, then asks a critic for a
structured verdict (`approved`, `feedback`, and `fix` of `rerun` or `rewrite` when rejected). A rerun
runs the base strategy again with the feedback and the actions already taken; a rewrite makes one
tool-free model call. Traces are joined with `critique` events, and metrics are summed. The arena
registers `reflect:react` and `reflect:plan-execute`. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js (see Constitution Check)

**Primary Dependencies**: Existing only: `langchain` 1.6, `@langchain/langgraph` 1.6,
`@langchain/openai` 1.8, `@langchain/core` 1.3, `zod` 4

**Storage**: `data/db.json` for runs, memory for tests (unchanged from feature 001)

**Testing**: `node:test` through `tsx`, with the existing `ScriptedChatModel` and fake strategies

**Target Platform**: Local CLI

**Project Type**: CLI over a library of strategies

**Performance Goals**: None; LLM calls and latency are measured, not targeted

**Constraints**: At most `1 + maxReflections` attempts; critic and rewrite run at temperature 0
through the shared model factory; no tools in the critic or the rewrite

**Scale/Scope**: 1 decorator, 2 new arena strategy names

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | Service: `src/agents/reflection.ts`. Controller: `src/arena.ts` registers the names. |
| II. Validated Boundaries | Pass | zod validates the critic verdict and `maxReflections`. CLI names reuse the existing zod enum. |
| III. Domain Errors at the Edge | Pass | No new domain errors. Critic failures become a `RunResult` with stop reason `error`. |
| IV. Pure Functions | Pass | Verdict routing, input building, trace and metrics merging are pure. Model and strategy calls stay in a thin loop. |
| V. Tested and Green | Pass | Pure helpers and the loop are tested with fake models and fake strategies. |
| Stack: MySQL through Sequelize | Exception | Still deferred, as in feature 001. |
| Stack: Node.js 22 LTS | Open | Machine runs v24; unchanged from feature 001. |
| Security | Pass | No new settings or secrets. |
| Workflow | Pass | Follows `/speckit-specify`. |

Post-design re-check: same result. The shared structured-output helper is a refactor, not a new
dependency.

## Project Structure

### Documentation (this feature)

```text
specs/002-reflection-layer/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── reflection.md
└── tasks.md             # Created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── arena.ts                        # Registers reflect:react and reflect:plan-execute
├── arena.test.ts                   # New names parse
├── domain/
│   └── types.ts                    # critique event gains approved and fix
├── trace/
│   ├── format.ts                   # Prints the verdict in [critique] lines
│   └── format.test.ts
└── agents/
    ├── structured-output.ts        # Retry helper moved out of plan-and-execute.ts
    ├── plan-and-execute.ts         # Uses the shared helper
    ├── reflection.ts               # withReflection and its pure helpers
    └── reflection.test.ts
```

**Structure Decision**: Single project, as in feature 001. The decorator lives with the strategies
in `src/agents/`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| MySQL through Sequelize deferred | Carried over from feature 001 | Same reason as feature 001 |
