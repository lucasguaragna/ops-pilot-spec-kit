# Implementation Plan: Chat Endpoint

**Branch**: `003-chat-endpoint` (name only; work is on `main`) | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-chat-endpoint/spec.md`

## Summary

Expose `POST /chat` on an Express 5 app built by `createApp(settings)`. The controller validates
the body with zod (400). The service looks the strategy up in a shared registry in
`src/agents/index.ts` (422 when unknown), wraps it with `withReflection` when `reflect` is true,
and runs it under a timeout. On timeout the run is aborted through a new `RunOptions.signal`, and
the reply is 504. A pure mapper turns the outcome into 200, 502, or 504, and the reply is checked
against its schema before it is sent. The arena moves to the same registry. Integration tests run
over real HTTP with fake strategies and no network. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js (see Constitution Check)

**Primary Dependencies**: Existing only: `express` 5.3, `zod` 4, `langchain` 1.6,
`@langchain/langgraph` 1.6, `@langchain/core` 1.3, `@langchain/openai` 1.8

**Storage**: `data/db.json` through the JSON file store (unchanged); memory for tests

**Testing**: `node:test` through `tsx`; global `fetch` against `app.listen(0)`; fake strategies and
`ScriptedChatModel`

**Target Platform**: Local HTTP server on `PORT` (default 3000)

**Project Type**: Web service over the existing library of strategies, plus the CLI arena

**Performance Goals**: None for throughput; a reply within the timeout plus 1 second (SC-003)

**Constraints**: Timeout 180 s by default and set per app; no new model or tool call after abort;
no stack traces or secrets in replies; test suite under 5 s with no network

**Scale/Scope**: 1 route, 1 registry, 1 new `RunOptions` field across 3 strategies

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | Controller: `src/http/chat-controller.ts`. Service: `src/http/chat-service.ts` calls the registry and strategies. Model: domain types and the store, unchanged. |
| II. Validated Boundaries | Pass | zod validates the body, every reply body (FR-010), and `PORT`. |
| III. Domain Errors at the Edge | Pass | New `UnknownStrategyError` class; only the controller maps it to 422. Run errors stay data (`RunError`) and map to 502 at the edge. |
| IV. Pure Functions | Pass | `createStrategy`, `toHttpReply`, and `toIssues` are pure. The timer, Express, and model calls stay at the edges. |
| V. Tested and Green | Pass | Unit tests for the registry, mapper, timeout helper, and abort in each strategy; integration tests for the route. |
| Stack: MySQL through Sequelize | Pass | Covered by the constitution's Stack Exceptions (v1.1.0): the JSON store stays behind the Model layer. |
| Stack: Node.js 22.9 or newer | Pass | Machine runs v24.15; `--env-file-if-exists` needs 22.9 or newer. |
| Security | Pass | `.env` loaded by Node with `--env-file-if-exists`, never read by code or agents; errors carry name and message only. |
| Workflow | Pass | Follows `/speckit-specify` and `/speckit-clarify`. |

Post-design re-check: same result. `RunOptions.signal` is optional, so existing callers and tests
are unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/003-chat-endpoint/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-http.md
└── tasks.md             # Created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── index.ts                        # Entry: reads PORT, builds real dependencies, listens
├── arena.ts                        # Uses the shared registry; derives reflect: names
├── arena.test.ts                   # Names still parse
├── domain/
│   ├── types.ts                    # RunOptions gains signal
│   └── errors.ts                   # UnknownStrategyError
├── agents/
│   ├── index.ts                    # strategyFactories, StrategyRegistry, createStrategy
│   ├── index.test.ts
│   ├── react.ts                    # Passes signal to agent.stream
│   ├── react.test.ts               # Aborted signal: no model call
│   ├── plan-and-execute.ts         # Passes signal to graph.stream
│   ├── plan-and-execute.test.ts
│   ├── reflection.ts               # Passes signal to base runs, critic, and rewrite
│   └── reflection.test.ts
└── http/
    ├── schemas.ts                  # ChatRequest, ChatReply, ErrorReply, TraceEvent schemas
    ├── chat-service.ts             # runWithTimeout and runChat
    ├── chat-service.test.ts
    ├── chat-reply.ts               # Pure outcome-to-status mapper and zod issue mapper
    ├── chat-reply.test.ts
    ├── chat-controller.ts          # Parses the body, calls the service, sends the reply
    ├── server.ts                   # createApp: json parser, route, error middleware
    └── server.test.ts              # Integration over real HTTP with fake strategies
package.json                        # dev script loads .env like arena and bench
```

**Structure Decision**: Single project, as in features 001 and 002. HTTP code goes in a new
`src/http/` folder, as the request asked. The registry goes in `src/agents/index.ts` next to the
strategies it builds.

## Complexity Tracking

No violations. The MySQL deferral is now a constitution exception (v1.1.0), not a plan violation.
