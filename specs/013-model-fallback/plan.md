# Implementation Plan: Model Fallback

**Branch**: `013-model-fallback` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-model-fallback/spec.md`

## Summary

When a call to the primary OpenRouter model fails after its retries, the same call goes once to a
fallback model named in `OPENROUTER_MODEL_FALLBACK`. Every switch shows as a `fallback` trace event,
`metrics.modelUsed` names the model that answered, and a run with no model left returns
`503 model_unavailable` instead of `502`.

The single model factory returns a `ResilientChatModel`. It binds tools or the output schema on
each `ChatOpenAI` first, and only then composes
`primary.withRetry(...).withFallbacks([fallback])`. This keeps `bindTools` and
`withStructuredOutput` working, which a bare `RunnableWithFallbacks` does not. Run metadata marks
each branch, so the existing `LlmCallCounter` can record switches and the answering model with no
new plumbing (research R1, R5).

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13+

**Primary Dependencies**: `@langchain/core` 1.3.2 (`withRetry`, `withFallbacks`, callbacks),
`@langchain/openai` 1.8.0 (`ChatOpenAI` on OpenRouter), `langchain` 1.6.0 (`createAgent`),
`@langchain/langgraph` 1.6, Express, zod. No new dependency.

**Storage**: N/A (nothing stored; SQLite untouched)

**Testing**: `node:test` through `tsx`, with `ScriptedChatModel` playing both models; no network

**Target Platform**: Node.js HTTP service (local), plus the `arena` and `bench` CLIs

**Project Type**: web service (single project, `src/`)

**Performance Goals**: no extra model calls when the primary works (SC-004)

**Constraints**: at most 2 attempts on each model per call, with about 2 s of backoff per model at
worst, inside the 180 s request timeout. Cancellation starts nothing new. No provider
text or key in replies or trace.

**Scale/Scope**: one fallback model; about 12 source files touched, 2 new

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | Model factory and counter stay in `agents/` (Model). Graph nodes copy counter data. Only `http/chat-reply.ts` (Controller edge) picks the status. |
| II. Validated Boundaries | Pass | `OPENROUTER_MODEL_FALLBACK` is parsed by the zod `ModelSettings`. The `fallback` event, `modelUsed`, and the 503 body are new branches of the HTTP zod schemas (FR-014). |
| III. Domain Errors at the Edge | Pass | `ModelUnavailableError` is a class in `domain/errors.ts`, mapped to 503 only in `toHttpReply` (FR-015). |
| IV. Pure Functions | Pass | `fallbackModelOf`, `fallbackEvents`, the `modelUsed` reducer, and `toHttpReply` are pure. Network calls stay in the models; the counter is the existing callback edge. |
| V. Tested and Green | Pass | Each new unit gets a test (see [quickstart.md](quickstart.md)). `npm run typecheck` and `npm test` gate done. |
| Security | Pass | No `.env` read: the user adds the setting to `.env` and `.env.example`. The trace holds model names and class names only. The 503 body holds no provider text or key. |
| Stack | Pass | Only LangChain primitives that are already installed. |

Re-check after Phase 1: still passing. The design adds no layer, store, or dependency.

## Project Structure

### Documentation (this feature)

```text
specs/013-model-fallback/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R11 decisions
├── data-model.md        # Phase 1: settings, switch, event, metrics, error
├── quickstart.md        # Phase 1: test and live validation
├── contracts/
│   ├── chat-api.md      # POST /chat: fallback event, modelUsed, 503
│   └── model-factory.md # createModel / createResilientModel / counter
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── agents/
│   ├── model.ts                 # settings + OPENROUTER_MODEL_FALLBACK, maxRetries: 0, returns BaseChatModel
│   ├── resilient-model.ts       # NEW: ResilientChatModel, createResilientModel, MODEL_ATTEMPTS
│   ├── resilient-model.test.ts  # NEW
│   ├── llm-counter.ts           # switches, modelUsed, handleLLMError; fallbackEvents()
│   ├── run-outcome.ts           # toRunError fills RunError.cause
│   ├── react.ts                 # prepend fallback events; metrics.modelUsed
│   ├── plan-and-execute.ts      # fallback events before plan/replan events; modelUsed
│   ├── reflection.ts            # fallback events before critique; modelUsed
│   └── history-summarizer.ts    # step carries switches + modelUsed (via chat-service counter)
├── domain/
│   ├── errors.ts                # ModelUnavailableError
│   └── types.ts                 # fallback TraceEvent, Metrics.modelUsed, RunError.cause
├── graph/
│   ├── router.ts                # RouterResult gains switches + modelUsed
│   └── production-graph.ts      # modelUsed channel; fallback events in context/router nodes
├── http/
│   ├── schemas.ts               # fallback event, modelUsed, model_unavailable reply
│   ├── chat-reply.ts            # 503 mapping
│   └── chat-service.ts          # summarizer counter data into the step
├── testing/scripted-chat-model.ts  # scripted errors per call (status, name)
├── arena.ts, bench.ts           # unchanged calls; Metrics literals gain modelUsed if any
README.md                        # documents OPENROUTER_MODEL_FALLBACK
```

**Structure Decision**: single project, current layout. One new module,
`src/agents/resilient-model.ts`, sits next to `model.ts`, so the factory stays the only place that
knows about OpenRouter.

## Phase 0: Research

See [research.md](research.md). No NEEDS CLARIFICATION remained. Three spec points were revised to
match the library's real behaviour:

- FR-010: `llmCalls` counts retries, because each `withRetry` attempt is its own chat model run (R6).
- FR-011: the 503 names the primary model's final error class, because `withFallbacks` rethrows the
  first error (R7).
- Summarization edge case: summarization runs inside the request (`context` node), so its
  switches are traced (R9).

## Phase 1: Design

- [data-model.md](data-model.md): entities and the per-call state diagram.
- [contracts/chat-api.md](contracts/chat-api.md): wire changes and the status mapping.
- [contracts/model-factory.md](contracts/model-factory.md): factory and counter guarantees.
- [quickstart.md](quickstart.md): automated and live validation.

Order of work for `/speckit-tasks` (each step ships with its test):

1. Types and error: `TraceEvent` fallback, `Metrics.modelUsed`, `RunError.cause`,
   `ModelUnavailableError`, `toRunError`.
2. `ScriptedChatModel` scripted failures. `createResilientModel` with retry, fallback, abort, and
   translation. Settings and `createModel`.
3. `LlmCallCounter` switches and `modelUsed`, plus `fallbackEvents`.
4. Strategies, router, summarizer, and graph: events and the `modelUsed` channel (US2).
5. HTTP schemas and the 503 in `toHttpReply`; server tests for 200, 503, and 502 (US1, US3).
6. README; tell the user to add `OPENROUTER_MODEL_FALLBACK` to `.env.example` and `.env`.

## Complexity Tracking

No constitution violations.
