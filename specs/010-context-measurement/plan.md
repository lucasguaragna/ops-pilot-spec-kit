# Implementation Plan: Context Measurement

**Branch**: `010-context-measurement` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-context-measurement/spec.md`

## Summary

A new `src/context/` module holds two pure pieces. `tokens.ts` has `estimateTokens` (characters
divided by 4, rounded up), `promptTokensOf(output)`, which reads the provider's
`usage_metadata.input_tokens` from a finished model call, and `addPromptTokens` for a nullable
sum. `breakdown.ts` has `contextBreakdown(texts)`, the per-source estimates plus their total, and
`toolDefinitionsText(tools)`. The existing `LlmCallCounter` gains a `handleLLMEnd` that sums the
real input tokens, so domain `Metrics` gains `promptTokens: number | null`. React, plan-execute,
and reflection fill it with no extra model call. `ReasoningStrategy` gains an optional
`systemPrompt`. `composeInput` and `composeMemoryInput` are split into pure `historyBlock` and
`memoryBlock` with unchanged output, so `runChat` can measure exactly what the agent receives and
pass a `ContextBreakdown` through `ChatOutcome`. The `/chat` 200 reply and the `run_failed` 502
reply with partial metrics then carry `metrics.promptTokens` and `metrics.contextBreakdown`. A new
`scripts/long-conversation.sh` (curl and jq) prints one line per turn of one conversation.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer; bash for the
script

**Primary Dependencies**: Express 5, zod 4, LangChain/LangGraph (`@langchain/core` 1.3:
`handleLLMEnd`, `usage_metadata`, `convertToOpenAITool`). No new npm dependency. The script needs
`curl` and `jq` (both present on the dev machine: jq 1.7.1)

**Storage**: None new. No table, no query, no DDL change

**Testing**: `node:test` via `tsx`. `ScriptedChatModel` with scripted `usage_metadata` per turn.
Fake strategies with known metrics for the HTTP and script tests. The script test starts the app
on port 0, runs the script through `execFile("bash", ...)`, and is skipped when `jq` is missing

**Target Platform**: Local Node.js HTTP service (127.0.0.1:3000 by default) and a POSIX shell

**Project Type**: Web service (single project) plus one shell script

**Performance Goals**: No extra model call (SC-004). The estimate is linear in the text length:
a few microseconds per request

**Constraints**:

- The answer, trace, stop reason, and `llmCalls` of every run stay the same (FR-009).
- The 504 timeout body and the 502 without partial metrics stay unchanged.
- The `/chat` request body is unchanged.
- `formatMetrics` (arena) and the bench rows are unchanged.
- The learning step's calls stay outside the reply's metrics.
- The MCP server is unchanged.

**Scale/Scope**: One request at a time per conversation; contexts of a few thousand tokens

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / rule | How the plan complies | Status |
| --- | --- | --- |
| I. Layered MVC | Controller unchanged. Service `chat-service` builds the breakdown texts and calls the pure `contextBreakdown`. Strategies (agents) read usage through their counter. `chat-reply` maps the outcome. `src/context/` is a pure helper with no store or HTTP import. | Pass |
| II. Validated boundaries | The reply schemas gain `promptTokens: Count.nullable()` and `ContextBreakdownSchema`, which also checks that `total` equals the sum. Provider usage is read defensively: only a non-negative integer `input_tokens` counts. The script reads only fields the schema guarantees. | Pass |
| III. Domain errors at the edge | No new error class. A missing usage is `null`, not an error. An unreachable server is a script exit status, not a server error. | Pass |
| IV. Pure functions | `estimateTokens`, `promptTokensOf`, `addPromptTokens`, `contextBreakdown`, `toolDefinitionsText`, `historyBlock`, and `memoryBlock` are pure. The counter is the existing callback edge. | Pass |
| V. Tested and green | Tests cover each pure function, the usage sums per strategy, the reply mapping and schema, and the script's output, all with fakes. `npm run typecheck` and `npm test` gate completion. | Pass |
| Stack | No new dependency. Bash, `curl`, and `jq` are dev tools for one script, not part of the app stack. | Pass |
| Secrets / `.env` | The script sends no key. The reply carries counts only, never prompt text. | Pass |
| Persistence rules | No database change. Tests use fake stores; the script test never touches `data/`. | Pass |

Post-design re-check: Pass. The one interface change (`Metrics.promptTokens`, required) is
deliberate (research R6). The optional `ReasoningStrategy.systemPrompt` keeps every existing fake
strategy valid.

## Project Structure

### Documentation (this feature)

```text
specs/010-context-measurement/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R8
├── data-model.md        # Phase 1: Metrics, ContextBreakdown, ContextTexts, TurnLine
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── context-module.md          # src/context API
│   ├── chat-metrics.md            # /chat reply metrics
│   └── long-conversation-script.md
├── checklists/requirements.md     # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── context/
│   ├── tokens.ts             # NEW estimateTokens, promptTokensOf, addPromptTokens
│   ├── tokens.test.ts        # NEW
│   ├── breakdown.ts          # NEW contextBreakdown, toolDefinitionsText, ContextBreakdown, ContextTexts
│   └── breakdown.test.ts     # NEW
├── domain/types.ts           # Metrics.promptTokens; ReasoningStrategy.systemPrompt?
├── agents/
│   ├── llm-counter.ts        # handleLLMEnd sums promptTokens (+ llm-counter.test.ts)
│   ├── react.ts              # metrics.promptTokens; systemPrompt
│   ├── plan-and-execute.ts   # metrics.promptTokens; systemPrompt = planner prompt
│   ├── reflection.ts         # sums attempts' promptTokens; passes systemPrompt through
│   ├── history.ts            # historyBlock; composeInput = historyBlock + message; withHistory passes systemPrompt
│   └── memories.ts           # memoryBlock; composeMemoryInput = memoryBlock + input; withMemories passes systemPrompt
├── http/
│   ├── chat-service.ts       # builds ContextTexts, ChatOutcome.context
│   ├── chat-reply.ts         # contextMetrics adds contextBreakdown
│   └── schemas.ts            # MetricsSchema.promptTokens, ContextBreakdownSchema
├── testing/scripted-chat-model.ts  # copies usage_metadata; withUsage helper
└── long-conversation.test.ts # NEW runs scripts/long-conversation.sh against a test server

scripts/
└── long-conversation.sh      # NEW (executable)
```

Existing tests that build `Metrics` literals get `promptTokens` (mechanical, about 30 sites).
`README.md` gets a short "Context measurement" section and a Features table row.

**Structure Decision**: Single project as before. `src/context/` is a new sibling of
`src/agents/` and `src/trace/`: pure helpers used by both the agents (the counter) and the
service (the breakdown). The script lives in a new top-level `scripts/` directory, as the spec
assumes. Its test sits in `src/` so the existing `src/**/*.test.ts` glob runs it.

## Complexity Tracking

No constitution violations to justify.
