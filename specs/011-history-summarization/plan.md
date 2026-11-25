# Implementation Plan: History Summarization

**Branch**: `011-history-summarization` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-history-summarization/spec.md`

## Summary

The agent now gets the newest 8 messages of a conversation word for word, plus one merged summary
of everything before them. Older messages that have not been summarized yet are also given word
for word, so the agent sees 8 to 14 messages.

**Storage.** The summary is one text (telegraphic bullets) stored in a new
`conversation_summaries` table, in the same SQLite file and behind the existing
`ConversationStore`. Three methods are added: `messagesAfter`, `summaryOf`, and a
compare-and-swap `saveSummary`.

**When it runs.** Inside `POST /chat`, after recall and before the agent runs. The pure
`planHistory` decides: summarization happens only when at least 8 uncovered messages are older than
the window. That is exchanges 9, 13, 17, and so on, never every request.

**How it summarizes.** A new `history-summarizer` makes one plain model call, with the prompt from
`docs/code-examples/spec11-example.ts` (in English). It gets the previous summary and the messages
to absorb, and returns the merged summary as text. Pure helpers then trim the lines, drop any line
`looksLikeSecret` flags (009), and fit the text to 300 estimated tokens (010's `estimateTokens`).

**On success:**

- The summary goes into the context: memories, summary, verbatim messages, current request.
- The reply's trace starts with a `summarize` event.
- The summarizer's calls and tokens join the metrics.

**On failure** (thrown, timeout, empty result, or a lost compare-and-swap): the request goes on with
the previous summary and the newest 14 uncovered messages, and the server writes one log line.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer

**Primary Dependencies**:

- Express 5, zod 4, `node:sqlite`.
- LangChain (`model.invoke` on the existing `ChatOpenAI`; no structured output).
- From earlier features: `estimateTokens` and `addPromptTokens` (010), `looksLikeSecret` (009),
  `LlmCallCounter`.

No new npm dependency.

**Storage**: One new table, `conversation_summaries`, in the file at `OPSPILOT_DB`. It is created
idempotently with `CREATE TABLE IF NOT EXISTS`. Every query is a prepared statement, and rows are
parsed with zod.

**Testing**: `node:test` via `tsx`.

- `ScriptedChatModel` with `textTurn(…)` for the summarizer.
- The store contract test runs against `":memory:"` and `FakeConversationStore`.
- A restart test uses a fresh directory under the OS temp dir.
- Fake strategies cover the service and HTTP tests.

**Target Platform**: Local Node.js HTTP service

**Project Type**: Web service (single project)

**Performance Goals**: At most 1 extra model call per 4 exchanges (SC-002), also when the
summarizer keeps failing, because attempts happen only on a batch boundary and make one call. No
summarization call on any other request.

**Constraints**:

- The summarizer has its own 30 s limit, outside the run's 180 s.
- A failed summarization never changes the status code, the answer, or the trace (FR-010).
- With no summary, the context and every existing composed string stay byte-identical.
- The request body, the MCP server, the memory and learning features (008, 009), and the five
  `contextBreakdown` sources (010) are unchanged.

**Scale/Scope**: Conversations of tens of exchanges. At most 14 verbatim messages plus one summary
of at most 300 estimated tokens in any context.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / rule | How the plan complies | Status |
| --- | --- | --- |
| I. Layered MVC | **Model**: the store interface gains three methods, and the SQL stays in `SqliteConversationStore`. **Service**: `chat-service` orchestrates plan, summarize, store, and run. **Agents**: `history-summarizer` holds the model call. **Controller**: unchanged. | Pass |
| II. Validated boundaries | The summarizer's reply is cleaned by `cleanSummary` and validated by `SummaryText`. Rows are parsed with `ConversationSummary`. The reply schema gains the `summarize` event, and the server already validates every reply. | Pass |
| III. Domain errors at the edge | No new error class. A summarization failure is an outcome that gets logged, not an error. An unknown id still throws `ConversationNotFoundError` before any summarization. | Pass |
| IV. Pure functions | `planHistory`, `summaryMessages`, `cleanSummary`, `fitSummary`, `renderSummary`, `historyBlock`, `withSummarization`, and `summaryLogLine` are pure. The model call and the store stay at the edges. | Pass |
| V. Tested and green | Every pure function, the store contract, the batching over 20 exchanges, persistence, the event, and the failure path are tested with fakes. `npm run typecheck` and `npm test` gate completion. | Pass |
| Stack | No new dependency. The model is the same `ChatOpenAI` on OpenRouter. | Pass |
| Secrets / `.env` | Summary lines pass `looksLikeSecret` before storage (FR-013). Logs never print summary text. | Pass |
| Persistence rules | `OPSPILOT_DB` path, prepared statements, idempotent DDL, and `CHECK` constraints (non-blank `summary`, `covered_messages > 0`). Tests use `":memory:"`, plus a temp-dir file for the restart test, never `data/`. | Pass |

**Post-design re-check**: Pass. Two deliberate interface changes:

1. `ConversationStore` gains three methods. Both implementations and the contract test change
   together.
2. `HISTORY_LIMIT = 12` is replaced by the window constants. The existing tests that assert 12 are
   updated (research R10).

## Project Structure

### Documentation (this feature)

```text
specs/011-history-summarization/
├── plan.md
├── research.md          # R1–R10
├── data-model.md        # table, constants, HistoryPlan, lifecycle, event
├── quickstart.md
├── contracts/
│   ├── conversation-store.md   # messagesAfter, summaryOf, saveSummary
│   ├── history-summarizer.md   # summarizer + history composition
│   └── chat-reply.md           # summarize event, metrics
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── schemas.ts            # SummaryText, ConversationSummary
│   └── types.ts              # TraceEvent gains "summarize"
├── store/
│   ├── conversation-store.ts           # + messagesAfter, summaryOf, saveSummary
│   ├── sqlite-conversation-store.ts    # conversation_summaries DDL + statements
│   └── conversation-store-contract.ts  # + contract cases
├── agents/
│   ├── history.ts            # HISTORY_WINDOW/SUMMARY_BATCH/MAX_VERBATIM, planHistory, historyBlock(summary)
│   ├── history-summarizer.ts # NEW summarizer, summaryMessages, cleanSummary, fitSummary, renderSummary (+ test)
│   └── learning-reflector.ts # unchanged; looksLikeSecret reused
├── http/
│   ├── chat-service.ts       # summarization step in runChat
│   ├── chat-reply.ts         # withSummarization, summaryLogLine
│   ├── schemas.ts            # TraceEventSchema + summarize
│   └── server.ts             # historyLimit removed; summaryTimeoutMs setting
├── trace/format.ts           # prints the summarize event
└── testing/fake-conversation-store.ts  # + the three methods
```

Tests are updated or added next to each file. `long-conversation.test.ts` gets the new count
sequence. `README.md` gets a short "History summarization" section and a Features row.
`scripts/long-conversation.sh` only gets its header comment updated (12-message limit becomes
the summarization).

**Structure Decision**: Single project as before. The summary lives in the conversation store
because it is part of a conversation. The summarizer sits next to the learning reflector in
`src/agents/`, because both are one model call with pure helpers around it.

## Complexity Tracking

No constitution violations to justify.
