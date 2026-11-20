# Implementation Plan: Persistent Conversation

**Branch**: `007-persistent-conversation` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-persistent-conversation/spec.md`

## Summary

`POST /chat` gains an optional `conversationId`. A new `ConversationStore` (create, append,
lastMessages) persists conversations and messages in the same SQLite file as the operations data,
through a new `SqliteConversationStore` built in the same style as `SqliteOpsStore`. Before each
run the service loads the last 12 messages, and a `withHistory` decorator composes them into the
strategy input (the same pattern as `withReflection`), so every strategy gets history without
strategy-specific changes. Only completed runs save the user message and the answer. Replies carry
`conversationId` and `metrics.historyMessages`. Tests run on `":memory:"` and on a fake store, and
both pass one shared contract suite.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer

**Primary Dependencies**: Express 5, zod 4, LangChain/LangGraph (unchanged); `node:sqlite`,
`node:crypto` (`randomUUID`). No new packages.

**Storage**: SQLite via `node:sqlite` `DatabaseSync`, in the file at `OPSPILOT_DB` (default
`./data/opspilot.db`). New tables: `conversations` and `messages`.

**Testing**: `node:test` via `tsx`; `":memory:"` databases; `FakeConversationStore`; the existing
`scripted-chat-model` for agent runs

**Target Platform**: Local Node.js HTTP service (listens on 127.0.0.1 by default)

**Project Type**: Web service (single project)

**Performance Goals**: Loading history adds one indexed query per request, which is negligible next
to the LLM calls. Prompt size is bounded by the window of 12 messages.

**Constraints**: Prepared statements only; idempotent DDL; CHECK on `role`; tests never touch
`data/`; the domain `Metrics` type and the `ReasoningStrategy` interface stay unchanged

**Scale/Scope**: One process, one shared connection per store; single-digit concurrent users

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / rule | How the plan complies | Status |
| --- | --- | --- |
| I. Layered MVC | Controller `chat-controller` → Service `chat-service` → Model `ConversationStore`. The store is injected through `AppSettings` and wired in `src/index.ts`. | Pass |
| II. Validated boundaries | `conversationId: z.uuid().optional()` in `ChatRequest`; `ChatReply` and `ErrorReply` gain the new fields and keep parsing every reply; rows are parsed with zod schemas. | Pass |
| III. Domain errors at the edge | `ConversationNotFoundError` is a class, thrown by the store and translated to 404 only in the controller. | Pass |
| IV. Pure functions | `composeInput`, `messagesToSave`, and `toHttpReply` are pure. Store calls and the run stay in the service, at the edge. | Pass |
| V. Tested and green | Contract suite (fake and SQLite), CHECK and restart tests, unit tests for the pure functions, HTTP tests. | Pass |
| Persistence: path from `OPSPILOT_DB` | Reuses `resolveDbPath`. | Pass |
| Persistence: tests use `":memory:"`; files only in a temp dir | Restart test uses `mkdtemp` and removes the directory. | Pass |
| Persistence: prepared statements | All statements are prepared in the constructor; `exec` only runs constant DDL. | Pass |
| Persistence: idempotent schema | `CREATE … IF NOT EXISTS`. | Pass |
| Persistence: CHECK on closed fields | `role IN ('user', 'assistant')`, with a parity test against `MessageRole`. | Pass |
| Persistence: in-memory only in tests | The fake lives in `src/testing/` and is never wired into `src/index.ts`. | Pass |
| Persistence: no SQL outside the Model | Services see only the `ConversationStore` interface. | Pass |
| No stack change | No new dependency. | Pass |

Post-design re-check: still all Pass. `AppSettings.conversations` is required, so production can
never fall back to the fake.

## Project Structure

### Documentation (this feature)

```text
specs/007-persistent-conversation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── chat-api.md
│   └── conversation-store.md
├── checklists/requirements.md
└── tasks.md             # created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── errors.ts                      # + ConversationNotFoundError
│   └── schemas.ts                     # + MessageRole, Conversation, NewMessage, StoredMessage
├── store/
│   ├── conversation-store.ts          # NEW: ConversationStore interface
│   ├── conversation-store-contract.ts # NEW: shared contract suite (not *.test.ts)
│   ├── sqlite-conversation-store.ts   # NEW: CONVERSATION_SCHEMA, class, openConversationStore
│   └── sqlite-conversation-store.test.ts
├── agents/
│   ├── history.ts                     # NEW: HISTORY_LIMIT = 12, composeInput, withHistory
│   └── history.test.ts
├── http/
│   ├── schemas.ts                     # conversationId in the request; reply fields; 404 variant
│   ├── chat-reply.ts                  # ChatOutcome.conversation; messagesToSave; conversationNotFoundReply
│   ├── chat-service.ts                # resolve conversation → run withHistory → save
│   ├── chat-controller.ts             # catch ConversationNotFoundError → 404
│   ├── server.ts                      # AppSettings.conversations (required), historyLimit (default 12)
│   └── *.test.ts                      # updated to pass FakeConversationStore
├── testing/
│   ├── fake-conversation-store.ts     # NEW
│   └── fake-conversation-store.test.ts
└── index.ts                           # openConversationStore() wired next to openOpsStore()
```

**Structure Decision**: Single project, using the existing `domain` / `store` / `agents` / `http`
layout. The MCP server, arena, and bench are untouched.

## Implementation Notes

- **Order inside `runChat`**: `createStrategy` (a 422 writes nothing) → `conversationId ?
  lastMessages(id, limit) : (create(), [])` → `runWithTimeout(withHistory(strategy, history).run)`
  → when the outcome is `done`, append each message from `messagesToSave` → return the outcome with
  `conversation: { id, historyMessages: history.length }`.
- **Learn-by-doing candidate**: `composeInput` in `src/agents/history.ts` (R2's format, with an
  empty history passing the message through unchanged) is a small, judgement-heavy pure function.
  It is a good fit for a human contribution during `/speckit-implement`.
- **Follow-up, not in scope**: a transactional `appendExchange` (see research R7); listing and
  deleting conversations.

## Complexity Tracking

No constitution violations, so nothing to justify.
