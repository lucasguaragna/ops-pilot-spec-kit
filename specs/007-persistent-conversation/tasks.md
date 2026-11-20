---

description: "Task list for feature 007: Persistent Conversation"
---

# Tasks: Persistent Conversation

**Input**: Design documents from `specs/007-persistent-conversation/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. The feature input asks for tests on `":memory:"` plus a fake, and the
constitution requires new logic to ship with a test. Within each story, write the tests first and
see them fail before you implement.

**Organization**: Tasks are grouped by user story, so each story can be built and tested on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1, US2, US3)
- Paths are relative to the repository root

---

## Phase 1: Setup

**Purpose**: Confirm a green baseline before any change.

- [X] T001 Run `npm run typecheck` and `npm test` at the repository root and confirm both pass on the current `main`, so later failures can be traced to this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Domain types, the error, the `ConversationStore` contract, and both implementations.
Every story depends on them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Add zod schemas and inferred types to `src/domain/schemas.ts`:
  - `MessageRole` = `z.enum(["user", "assistant"])` (a closed set; `user` is the engineer and `assistant` is the copilot, FR-014)
  - `Conversation` = `{ id: string, createdAt: string }` (`id` is a UUID; `createdAt` is ISO 8601)
  - `NewMessage` = `{ role: MessageRole, content: string }`, where `content` has no minimum length (a completed answer may be an empty string)
  - `StoredMessage` = `NewMessage` + `{ id: number (int), conversationId: string, createdAt: string }`
- [X] T003 [P] Add `ConversationNotFoundError extends Error` to `src/domain/errors.ts`:
  - It carries a readonly `conversationId`, and its message is `Conversation not found: <id>`
  - It does NOT extend `DomainError`, matching `UnknownStrategyError` (research R6)
- [X] T004 Create the `ConversationStore` interface in `src/store/conversation-store.ts` with `create(): Conversation`, `append(conversationId, message: NewMessage): StoredMessage`, and `lastMessages(conversationId, limit): StoredMessage[]`. Copy the JSDoc from [contracts/conversation-store.md](contracts/conversation-store.md): "newest `limit` messages, oldest first", and "throws ConversationNotFoundError for an unknown id".
- [X] T005 Create `runConversationStoreContract(label, make)` in `src/store/conversation-store-contract.ts`. Model it on `src/store/ops-store-contract.ts`; it is not a `*.test.ts` file. It uses `node:test` and covers the nine behaviours in [contracts/conversation-store.md](contracts/conversation-store.md):
  1. A new conversation has an empty `lastMessages(id, 12)`
  2. Two `create()` calls give distinct ids
  3. `append` returns `conversationId`, `role`, `content`, and `createdAt` taken from the injected `now`
  4. Messages come back in append order
  5. With 20 messages, `lastMessages(id, 12)` gives messages 9 to 20, oldest first
  6. With 5 messages, `lastMessages(id, 12)` gives all 5
  7. A limit of 0 gives `[]`
  8. Conversations are isolated from each other
  9. `append` and `lastMessages` on an unknown id throw `ConversationNotFoundError` carrying the id
  - `make` receives `{ now, newId }` options, so ids and timestamps are deterministic
- [X] T006 [P] Implement `FakeConversationStore({ now?, newId? })` in `src/testing/fake-conversation-store.ts`. It keeps a `Map<string, StoredMessage[]>`, uses array position for order, and assigns a counter for `id`. The defaults are `crypto.randomUUID` and `() => new Date()`. It is for tests only and is never imported by `src/index.ts`.
- [X] T007 [P] Implement `SqliteConversationStore(path, { now?, newId? })` with `close()` in `src/store/sqlite-conversation-store.ts`. Follow `src/store/sqlite-ops-store.ts`.
  - Export `CONVERSATION_SCHEMA` exactly as in [data-model.md](data-model.md):
    - `conversations(id TEXT PRIMARY KEY CHECK (length(id) > 0), created_at TEXT NOT NULL) STRICT`
    - `messages(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`
    - `CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id)`
  - Set the pragmas `foreign_keys = ON` and `busy_timeout = 5000`
  - Prepare every statement once in the constructor. `lastMessages` uses `ORDER BY id DESC LIMIT ?` in a subquery and then re-sorts ascending (research R4).
  - Look up whether the conversation exists before reading or appending, and throw `ConversationNotFoundError` if it does not
  - Parse rows into `StoredMessage` with zod
  - Export `openConversationStore(env = process.env)`, which uses `resolveDbPath` and throws `StoreOpenError` on failure, mirroring `openOpsStore`
- [X] T008 [P] Create `src/testing/fake-conversation-store.test.ts`, which calls `runConversationStoreContract("FakeConversationStore", …)`
- [X] T009 [P] Create `src/store/sqlite-conversation-store.test.ts`. It runs `runConversationStoreContract("SqliteConversationStore", …)` on `":memory:"`, plus these SQLite-only tests:
  - A raw `INSERT` with role `'system'` fails on the CHECK
  - A parity test: the role list parsed from `CONVERSATION_SCHEMA` equals `MessageRole.options`
  - A raw insert into `messages` with an unknown `conversation_id` fails on the foreign key

**Checkpoint**: Both stores pass the same contract, and `npm test` is green.

---

## Phase 3: User Story 1 - Follow-up questions keep their context (Priority: P1) 🎯 MVP

**Goal**: `POST /chat` takes an optional `conversationId`, gives the agent the earlier exchanges,
saves completed exchanges, and returns `conversationId` and `metrics.historyMessages`.

**Independent Test**: Over HTTP on the fake store, send a message with no id, keep the returned
id, send a follow-up with that id, and check that the scripted model received the first question
and its answer before the new message, and that `historyMessages` is 2.

### Tests for User Story 1 (write first, see them fail)

- [X] T010 [P] [US1] Create `src/agents/history.test.ts`:
  - `composeInput([], "hi")` returns `"hi"` unchanged
  - A two-message history gives exactly the research R2 format: `Conversation so far (oldest first):\nUser: …\nAssistant: …\n\nCurrent request: <message>`
  - `withHistory(strategy, history).run(input, options)` calls the inner strategy with the composed input and passes `options` through unchanged (check with a recording stub strategy)
- [X] T011 [P] [US1] Extend `src/http/schemas.test.ts`:
  - `ChatRequest` accepts a missing `conversationId` and a valid UUID
  - `"abc"` and `""` fail with the issue path `["conversationId"]`
  - `ChatReply` requires `conversationId` and `metrics.historyMessages`
  - `ErrorReply` accepts the 404 `conversation_not_found` shape from [contracts/chat-api.md](contracts/chat-api.md)
- [X] T012 [P] [US1] Extend `src/http/chat-reply.test.ts`:
  - A table test for `messagesToSave(message, outcome)`: `completed` gives `[user, assistant]` in that order, while `iteration_limit`, `error`, and `timeout` give `[]`
  - A table test for `toHttpReply`: the 200, 502, and 504 bodies carry `conversationId`, and every `metrics` carries `historyMessages`
- [X] T013 [US1] Extend `src/http/chat-service.test.ts` with `FakeConversationStore` and the scripted chat model:
  - With no id, a conversation is created and `historyMessages` is 0
  - A follow-up with that id gives the model the earlier exchange, and `historyMessages` is 2
  - A completed run saves user then assistant
  - Run failure, timeout, and iteration limit each save nothing
  - An unknown strategy creates no conversation (check order: the 422 comes before any store call)
  - An unknown id throws `ConversationNotFoundError` and the model is never called
- [X] T014 [US1] Extend `src/http/server.test.ts` (HTTP, on the fake):
  - A new conversation gives a 200 with `conversationId` and `historyMessages` 0
  - A follow-up gives the same id and `historyMessages` 2
  - A random UUID gives a 404 `conversation_not_found` with `conversationId`
  - `"conversationId":"abc"` gives a 400 `invalid_body`
  - A failed run gives a 502 carrying the new conversation's id, and that conversation then has 0 messages

### Implementation for User Story 1

- [X] T015 [US1] Create `src/agents/history.ts`:
  - Export `HISTORY_LIMIT = 12`
  - Export `composeInput(history: readonly NewMessage[], message: string): string`, a pure function implementing the research R2 format, which passes the message through unchanged when the history is empty
  - Export `withHistory(strategy, history): ReasoningStrategy`, which mirrors `withReflection` and keeps the inner strategy's `name`
  - Leave the body of `composeInput` as the single `TODO(human)` (Learn by Doing)
- [X] T016 [P] [US1] Update `src/http/schemas.ts`:
  - `ChatRequest` gains `conversationId: z.uuid().optional()`
  - `ChatReply` gains `conversationId`, and its `metrics` gains `historyMessages: z.number().int().min(0).max(12)`
  - The 502 and 504 variants of `ErrorReply` gain a required `conversationId`
  - Add the 404 variant `{ error: "conversation_not_found", message, conversationId }`
  - Leave 400, 422, and 500 unchanged
- [X] T017 [US1] Update `src/http/chat-reply.ts`:
  - `ChatOutcome` gains `conversation: { id: string; historyMessages: number }`
  - Add the pure `messagesToSave(message, outcome): NewMessage[]`, which returns `[user, assistant]` only for `done` with `stopReason: "completed"`
  - `toHttpReply` puts `conversationId` on the 200, 502, and 504 bodies and merges `historyMessages` into `metrics`
  - Add the pure `conversationNotFoundReply(error)`, which returns status 404
  - The domain `Metrics` type stays unchanged
- [X] T018 [US1] Update `src/http/chat-service.ts` `runChat` to follow the order in [plan.md](plan.md) Implementation Notes:
  1. `createStrategy`
  2. If there is an id, `lastMessages(id, historyLimit)`; otherwise `create()` with `[]`
  3. `runWithTimeout(withHistory(strategy, history).run …)`
  4. When the outcome is `done`, append each item from `messagesToSave` with no `await` between the appends
  5. Return the outcome with `conversation: { id, historyMessages: history.length }`
- [X] T019 [US1] Update `src/http/chat-controller.ts` to catch `ConversationNotFoundError`, reply with `conversationNotFoundReply`, and parse the body with `ErrorReply`, in the same way `UnknownStrategyError` is handled
- [X] T020 [US1] Update `src/http/server.ts`:
  - `AppSettings` gains a required `conversations: ConversationStore` and an optional `historyLimit`, which defaults to `HISTORY_LIMIT` in `resolveSettings`
  - Pass both to the chat service
- [X] T021 [US1] Update the existing callers of `createApp` and `runChat` in `src/http/server.test.ts` and `src/http/chat-service.test.ts` to pass a fresh `FakeConversationStore`, so the existing cases stay green without any other change (SC-006)
- [X] T022 [US1] Wire `openConversationStore()` in `src/index.ts`:
  - Open it next to `openOpsStore()`, with the same `StoreOpenError` handling and exit path
  - Pass it as `conversations` to `createApp`
  - Close it on shutdown, as the ops store is closed

**Checkpoint**: US1 works end to end on the fake (HTTP tests) and on SQLite (`npm run dev`, quickstart steps 1, 2, 4, and 5).

---

## Phase 4: User Story 2 - Conversations survive a restart (Priority: P2)

**Goal**: The saved messages are read back after the store is closed and reopened on the same file.

**Independent Test**: In a fresh OS temporary directory, save an exchange, close the store, open a
new store on the same file, and read the same messages back.

- [X] T023 [P] [US2] Add a restart test to `src/store/sqlite-conversation-store.test.ts`:
  - Use `mkdtemp(join(tmpdir(), "opspilot-conv-"))`
  - Create a conversation, append user then assistant, `close()`, then open a new `SqliteConversationStore` on the same file
  - Check that `lastMessages(id, 12)` gives the same ids, roles, content, and order
  - Remove the directory in `after`/`finally`
  - Never touch `OPSPILOT_DB` or `data/`
- [X] T024 [P] [US2] Add an idempotent-open test to `src/store/sqlite-conversation-store.test.ts`: in a temp directory, opening twice on the same file, or running `CONVERSATION_SCHEMA` twice, neither throws nor loses rows
- [X] T025 [US2] Add a test that `SqliteConversationStore` and `SqliteOpsStore` can share one file. In a temp directory, open both on the same path, write through each, and read back through each. This proves the two-connection decision in research R3 (FR-011).

**Checkpoint**: Restart, idempotence, and the shared-file tests are green. Quickstart step 3 gives `historyMessages` 4.

---

## Phase 5: User Story 3 - Long conversations stay bounded (Priority: P3)

**Goal**: Only the 12 most recent earlier messages reach the agent, and the reply reports how many were used.

**Independent Test**: Seed a conversation with 20 messages, send one more, and check that the agent
received exactly the 12 most recent earlier messages, oldest first, with `historyMessages` 12.

- [X] T026 [P] [US3] Add window tests to `src/http/chat-service.test.ts`, seeding `FakeConversationStore` directly:
  - 20 messages: the composed input holds messages 9 to 20, oldest first, does not hold message 8, and `historyMessages` is 12
  - 5 messages: all 5 are used, and `historyMessages` is 5
- [X] T027 [P] [US3] Add a test to `src/http/server.test.ts`:
  - The default `historyLimit` resolves to `HISTORY_LIMIT` (12)
  - An explicit `historyLimit` in `AppSettings` is honoured
- [X] T028 [US3] Decided: `metrics.historyMessages` stays a non-negative integer with no `max(12)` in `ChatReply`, because an operator can raise `historyLimit` on purpose. The default 12 comes from `HISTORY_LIMIT` in one place.

**Checkpoint**: All three stories pass independently.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T029 [P] Update `README.md` to document `conversationId` in the `/chat` request and reply, the new 404, and `metrics.historyMessages`, with a two-call example taken from [quickstart.md](quickstart.md)
- [X] T030 [P] Confirm that the MCP server (`src/mcp/`), `src/arena.ts`, and `src/bench.ts` are unchanged and still compile: they stay single-turn
- [X] T031 Run `npm run typecheck` and `npm test`, and both must be green. Then run quickstart steps 1 to 5 by hand against a scratch `OPSPILOT_DB` path.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: depends on Setup and blocks every story
- **US1 (Phase 3)**: depends on Foundational. It includes the `src/index.ts` wiring, because `AppSettings.conversations` becomes required and typecheck needs the real store wired in.
- **US2 (Phase 4)**: depends on Foundational (T007) only. Its tests are store-level and can run alongside US1.
- **US3 (Phase 5)**: depends on US1 (T018 and T020), since the window flows through `runChat` and `historyLimit`
- **Polish (Phase 6)**: after every story you want to ship

### Within Phases

- T002 and T003 come before T004, and T004 comes before T005, T006, and T007. T005 comes before T008 and T009.
- In US1, write the tests T010 to T014 first, and they should fail. Then implement:
  - T015, then T016 and T017, then T018, then T019 and T020, then T021, then T022
- T021 must land together with T020, or the existing HTTP tests stop compiling

### Parallel Opportunities

- Phase 2: T002 and T003 together; after T004 and T005, T006 and T007 together, then T008 and T009 together
- US1 tests: T010, T011, and T012 together (different files)
- US1 implementation: T016 alongside T015 (`schemas.ts` versus `history.ts`)
- US2 (T023 and T024) can run while US1 is in progress, once T007 is done
- Polish: T029 and T030 together

### Parallel Example: User Story 1

```text
Task: "T010 composeInput / withHistory tests in src/agents/history.test.ts"
Task: "T011 ChatRequest / ChatReply / ErrorReply schema tests in src/http/schemas.test.ts"
Task: "T012 messagesToSave / toHttpReply table tests in src/http/chat-reply.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1, then Phase 2 (both stores pass the contract)
2. Phase 3 (US1): follow-ups work, ids are returned, and completed turns are saved
3. **Stop and validate**: run quickstart steps 1, 2, 4, and 5. Because US1 wires the SQLite store, the MVP already persists. US2 adds the proof of that.

### Incremental Delivery

1. US1 delivers multi-turn chat (MVP)
2. US2 delivers the restart guarantee, under test
3. US3 delivers the bounded window, under test
4. Polish covers the docs and the final green run

### Learn by Doing

- T015 leaves `composeInput` in `src/agents/history.ts` as the only `TODO(human)`. T010 already states the expected format, so the human contribution has a test to pass.

## Notes

- `[P]` means a different file with no dependency on an unfinished task
- Every query uses a prepared statement. Tests use only `":memory:"` or a fresh `mkdtemp` directory, and never `OPSPILOT_DB` or `data/`.
- Never read `.env`
