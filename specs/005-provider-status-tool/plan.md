# Implementation Plan: Provider Status Tool

**Branch**: `005-provider-status-tool` (name only; work is on `main`) | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-provider-status-tool/spec.md`, plus the reference
sketch `docs/code-examples/example-referencia-retorno-aplicacao.ts`

## Summary

A new agent tool, `check_provider_status`, reports the overall status of GitHub or Cloudflare from
their public statuspage.io endpoint, in one line.

- **Module**: `src/providers/provider-status.ts` holds the provider-to-URL table, the zod schema
  for the status body, and pure functions that classify a response, decide whether to retry, and
  format the success line and the failure text. The only side effect, the HTTP call, goes through
  an injected `fetch`.
- **Resilience**: every attempt gets `AbortSignal.timeout(timeoutMs)` (default 5000). A network
  failure, a timeout, or a 5xx triggers exactly one more attempt. A 4xx or an invalid body is
  final at once.
- **Never throws**: the attempt loop returns a result value (success or a typed failure), and the
  tool maps it to text. Even an unexpected error becomes `Error: ...`.
- **Tool**: `createTools(store, deps?)` gains an optional `{ fetch, timeoutMs }` and appends the
  new tool as the sixth entry, so existing destructuring keeps working.
- **Reference sketch**: the plan keeps its shape (URL table, zod schema, loop of two attempts,
  injected fetch) and fixes five defects in it (see [research.md](research.md) R1).

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js 22.13+

**Primary Dependencies**:

- Existing: `zod` 4, `@langchain/core` 1.3 (`tool`).
- Built-in: global `fetch`, `AbortSignal.timeout` (Node 18+).
- No new dependency.

**Storage**: N/A. The tool does not touch the ops store (FR-011).

**Testing**: `node:test` through `tsx`. A fake `fetch` returns scripted `Response` objects or
rejects, and counts calls. The timeout test uses a short `timeoutMs` (for example 20 ms) and a
fake `fetch` that never settles until its `signal` aborts, which proves the signal is wired in.
No test uses the network (FR-010, SC-005).

**Target Platform**: Local HTTP server and CLI (arena, bench), same as the other tools

**Project Type**: Web service and CLI over the agent library

**Performance Goals**: Worst case about 10 s per call (two attempts of 5 s, SC-002); no retry
delay, since the second attempt is immediate.

**Constraints**:

- Only the two fixed URLs are ever requested (FR-002).
- The tool result is one line, capped at 200 characters on success (SC-004).
- No exception leaves the tool (FR-007).

**Scale/Scope**: 1 new module with its test file, 1 new zod input schema, 1 new tool, 1 optional
parameter on `createTools`, the tool-name test updated from five to six names

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | `src/providers/provider-status.ts` is a Model-layer gateway beside `src/store/`. The tool in `src/agents/tools.ts` calls it; services and the controller are unchanged. |
| II. Validated Boundaries | Pass | Tool input is the zod `CheckProviderStatusInput` (enum with default). The outside response is parsed with the zod `StatusPageBody` before use; anything else is an `invalid` failure. |
| III. Domain Errors at the Edge | Pass, with a note | No domain error class is added: a failed status check is not a domain rule violation but an observation, and FR-007 forbids throwing. Failures are a typed union value, turned into `Error: ...` text only in the tool (the edge). See R4. |
| IV. Pure Functions | Pass | `statusUrl`, `classifyResponse`, `classifyError`, `isRetryable`, `formatStatusLine`, and `formatFailure` are pure. `checkProviderStatus` is the only function with a side effect, and it takes `fetch` as a parameter. |
| V. Tested and Green | Pass | Unit tests for every pure function and for the loop with a fake fetch (success, timeout, invalid body, retry after 5xx, no retry on 4xx, unexpected throw), plus tool tests for the default provider and the schema rules. Typecheck and tests gate the work. |
| Stack | Pass | Built-in `fetch` and `AbortSignal`; no new dependency. |
| Persistence rules | N/A | No database access. |
| Security: no secrets | Pass | Public endpoints, no key. The URL comes only from the closed table, never from model input. |

No violations, so Complexity Tracking stays empty.

**Post-design re-check (after Phase 1)**: Pass. The contract and data model add no layer, no
dependency, and no thrown error.

## Project Structure

### Documentation (this feature)

```text
specs/005-provider-status-tool/
├── plan.md              # This file
├── research.md          # Phase 0: decisions R1-R7
├── data-model.md        # Phase 1: provider, status, attempt outcome, failure
├── quickstart.md        # Phase 1: how to validate
├── contracts/
│   └── check-provider-status.md   # Tool and module contract
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── provider-status.ts        # NEW: URL table, zod body schema, pure classifiers and
│   │                             #      formatters, checkProviderStatus(provider, deps)
│   └── provider-status.test.ts   # NEW: pure functions + loop with fake fetch
├── domain/
│   └── schemas.ts                # + Provider enum, CheckProviderStatusInput
└── agents/
    ├── tools.ts                  # createTools(store, deps?) + check_provider_status (6th)
    └── tools.test.ts             # six names; schema rules cover the new tool; default provider
```

Entry points (`index.ts`, `arena.ts`, `bench.ts`) keep calling `createTools(store)`; the default
deps use the global `fetch` and 5000 ms.

**Structure Decision**: Single project, existing layout. The new folder `src/providers/` keeps the
outside-HTTP gateway apart from `src/store/` (SQL) and `src/agents/` (LangChain wiring).

## Complexity Tracking

No constitution violations to justify.
