---

description: "Task list for 011 History Summarization"
---

# Tasks: History Summarization

**Input**: Design documents from `specs/011-history-summarization/`

**Prerequisites**:

- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/](contracts/)
- [quickstart.md](quickstart.md)

**Tests**: Requested. The feature input says "com teste fake", and FR-014 and SC-006 require
tests with a fake model, never the real provider, and never `data/`. Within each story, write
the tests first and see them fail, then implement.

**Organization**: Tasks are grouped by user story, so each story can be implemented and tested on
its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Path Conventions

The project is a single package. Source files live in `src/`, each test sits next to the file it
tests as `*.test.ts`, and the glob `src/**/*.test.ts` runs them all.

Standing rules for every task:

- Tests never open, create, or change the database at `OPSPILOT_DB` or anything under `data/`.
  They use `":memory:"`, the fake stores, and `ScriptedChatModel`. The restart tests use a fresh
  directory under the OS temp dir, removed afterwards.
- Every query uses a prepared statement with bound parameters. `exec` sees only constant DDL.
- Never read `.env`.
- New logic is a pure function wherever possible.
- `npm run typecheck` and `npm test` are green at every checkpoint.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the baseline before changing shared interfaces.

- [X] T001 From the repository root, run `npm run typecheck` and `npm test`, and confirm both are green before any change. This is the baseline for SC-006.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The summary's domain type and its storage, which all three stories read or write.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Write the new file `src/domain/schemas.test.ts` for the summary types:
  - `SummaryText` trims, and accepts any non-blank text. It rejects `""` and `"   "`.
  - `ConversationSummary`:
    - `conversationId` is a non-empty string.
    - `summary` is a `SummaryText`.
    - `coveredMessages` is an integer > 0. It rejects 0, -1, and 1.5.
    - `updatedAt` is a string.
- [X] T003 In `src/domain/schemas.ts`, add exactly these, with their types exported:
  - `SummaryText = z.string().trim().min(1)`
  - `ConversationSummary = z.object({ conversationId: z.string().min(1), summary: SummaryText, coveredMessages: z.number().int().positive(), updatedAt: z.string() })`
- [X] T004 Extend `runConversationStoreContract` in `src/store/conversation-store-contract.ts` with every row of the table in [contracts/conversation-store.md](contracts/conversation-store.md):
  - **`messagesAfter`**: `(id, 0)`, `(id, 3)`, and `(id, 9)` on 5 messages.
    - The results are oldest first.
    - `-1` throws.
  - **`summaryOf`**: `undefined` on a new conversation.
  - **`saveSummary`**, in this order:
    1. `(id, "- a", 0, 8)` returns `true`, and `summaryOf` returns the text with `coveredMessages: 8`.
    2. A second `(…, 0, 8)` returns `false` and leaves the summary unchanged.
    3. `(…, 8, 16)` returns `true`.
    4. A stale `(…, 8, 24)` returns `false`.
    5. `(…, 8, 8)` throws, because coverage must grow.
    6. A blank summary (`"   "`) throws.
  - Every new method throws `ConversationNotFoundError` for an unknown id.
- [X] T005 Add the three methods to the `ConversationStore` interface in `src/store/conversation-store.ts`, with the doc comments from [contracts/conversation-store.md](contracts/conversation-store.md):
  - `messagesAfter(conversationId: string, covered: number): StoredMessage[]`
  - `summaryOf(conversationId: string): ConversationSummary | undefined`
  - `saveSummary(conversationId: string, summary: string, expectedCovered: number, coveredMessages: number): boolean`
- [X] T006 [P] Implement the methods in `src/store/sqlite-conversation-store.ts`:
  - **DDL**: append the `conversation_summaries` DDL from [data-model.md](data-model.md) verbatim to `CONVERSATION_SCHEMA`:
    - `conversation_id TEXT PRIMARY KEY REFERENCES conversations(id)`
    - `summary TEXT NOT NULL CHECK (length(trim(summary, ' ' || char(9) || char(10) || char(13))) > 0)`, because SQLite's plain `trim` strips only spaces
    - `covered_messages INTEGER NOT NULL CHECK (covered_messages > 0)`
    - `updated_at TEXT NOT NULL`, with `STRICT` and `CREATE TABLE IF NOT EXISTS`
  - **Prepared statements**:
    - `messagesAfter`: `SELECT … FROM messages WHERE conversation_id = ? ORDER BY id LIMIT -1 OFFSET ?`. `covered` is validated as a non-negative integer by zod before it is bound.
    - `summaryOf`: one `SELECT` by `conversation_id`. Parse the row with `ConversationSummary`.
    - `saveSummary` validates `summary` with `SummaryText`, and requires `coveredMessages > expectedCovered` (zod).
    - When `expectedCovered === 0`: `INSERT INTO conversation_summaries (…) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`.
    - Otherwise: `UPDATE conversation_summaries SET summary = ?, covered_messages = ?, updated_at = ? WHERE conversation_id = ? AND covered_messages = ?`.
    - It returns `changes === 1`. The summary is bound as the trimmed text.
  - Every method first calls `requireConversation`.
- [X] T007 [P] Implement the same three methods in `src/testing/fake-conversation-store.ts`, with the same rules:
  - zod checks on `covered`, `summary`, and coverage growth.
  - Compare-and-swap on the stored coverage.
  - `ConversationNotFoundError` for an unknown id.
  - `updatedAt` comes from `now()`.

  It keeps summaries in a `Map<string, ConversationSummary>`.
- [X] T008 Extend `src/store/sqlite-conversation-store.test.ts`, using a fresh `mkdtemp` directory under `os.tmpdir()`, removed in `after`:
  - A summary saved by one `SqliteConversationStore` is returned by a second store opened on the same file (FR-002).
  - A database file created with only the pre-011 tables (create it with the old `conversations`/`messages` DDL written out in the test) opens with the new store. The table is added, every message is kept, and `summaryOf` is `undefined`.
  - A row edited to `covered_messages = 0` or `summary = '  '` is rejected by the `CHECK` constraints.

**Checkpoint**: `npm run typecheck` and `npm test` are green. The contract passes for both stores.

---

## Phase 3: User Story 1 - A long conversation keeps its early decisions (Priority: P1) 🎯 MVP

**Goal**: The agent gets a stored summary under its own label, then the uncovered messages word for word (8 to 14), then the current request. Remembered facts stay first. With no summary and 8 or fewer earlier messages, the context is byte-identical to today.

**Independent Test**: Seed a conversation with 16 messages and a stored summary covering the first 8. Send a message with a fake strategy. The recorded input must equal `renderSummary(stored) + historyBlock(last 8) + message`.

### Tests and implementation for User Story 1

- [X] T009 [P] [US1] Extend `src/agents/history.test.ts`:
  - **Constants**: replace the `HISTORY_LIMIT` test with `HISTORY_WINDOW === 8`, `SUMMARY_BATCH === 8`, `MAX_VERBATIM === 14`, and `SUMMARY_MAX_TOKENS === 300`.
  - **`planHistory`**: cover every row of the HistoryPlan table in [data-model.md](data-model.md), with `outside = length - 8`, using uncovered lengths 0, 8, 14, 15, 16, 17, 18, 20, 22, and 24.
    - **Due** (`outside >= 8 && outside % 8 < 2`, which is lengths 16, 17, and 24): `toSummarize` is `uncovered.slice(0, outside)` and `verbatim` is the last 8.
    - **Not due** (0, 8, 14, 15, 18, 20, and 22): `toSummarize` is `[]` and `verbatim` is `uncovered.slice(-14)`.
      - Lengths 18, 20, and 22 are the "after a failed attempt" states. They give exactly 14 verbatim.
  - **`historyBlock`**:
    - `historyBlock([], "")` is `""`.
    - `historyBlock(h)` equals `historyBlock(h, "")`, byte-identical to the current output.
    - `historyBlock(h, "S\n\n")` is `"S\n\n" + historyBlock(h)`.
  - **`composeInput`**: `composeInput(h, m, s)` equals `historyBlock(h, s) + m`.
  - **`withHistory`**: `withHistory(strategy, h, s)` runs the strategy with `composeInput(h, input, s)`.
- [X] T010 [US1] In `src/agents/history.ts`:
  - Replace `HISTORY_LIMIT` with `HISTORY_WINDOW = 8`, `SUMMARY_BATCH = 8`, `MAX_VERBATIM = 14`, and `SUMMARY_MAX_TOKENS = 300`, each with a doc comment from the Constants table in [data-model.md](data-model.md).
  - Add the pure `planHistory(uncovered)`.
  - Add the optional `summary = ""` parameter to `historyBlock`, `composeInput`, and `withHistory`. The summary text goes first, then today's block.
  - Keep `carrySystemPrompt`.
- [X] T011 [P] [US1] Write the new file `src/agents/history-summarizer.test.ts`, with `renderSummary` cases only:
  - The contract example `"- A\n- B"` renders to `"Summary of the earlier conversation (oldest messages first, merged):\n- A\n- B\n\n"`.
  - A blank summary (`""`, `"  \n "`) renders to `""`.
- [X] T012 [US1] Create `src/agents/history-summarizer.ts` with the pure `renderSummary(summary: string): string` from [contracts/history-summarizer.md](contracts/history-summarizer.md):
  - The header line is `Summary of the earlier conversation (oldest messages first, merged):`.
  - Then the summary text, then a blank line.
  - A blank summary gives `""`.
- [X] T013 [P] [US1] Extend `src/http/chat-service.test.ts` with a `runChat: summary in context` suite. Use `FakeConversationStore`, seeded with `seed()` plus `saveSummary`, and `recordingStrategy`:
  - 16 messages and a summary covering 8: the input is `renderSummary(stored) + historyBlock(last 8) + message`. `outcome.conversation.historyMessages === 8` and `context.history === estimateTokens(historyBlock(last 8, renderSummary(stored)))` (US1-AS1).
  - 6 earlier messages and no summary: the input is identical to `composeInput(those 6, message)` (US1-AS2).
  - A `userId` with one recalled fact: the input is `memoryBlock(recalled) + renderSummary(stored) + historyBlock(verbatim) + message` (US1-AS4).
  - 14 earlier messages and no summary: all 14 are given word for word.
  - Replace the test "uses only the 12 newest earlier messages, oldest first" with "gives at most the 14 newest word for word". It seeds 20 messages with no summary (outside 12, not due), and expects `historyMessages === 14`, the newest 14 in order, and no model call.
- [X] T014 [US1] In `src/http/server.ts`:
  - Remove `historyLimit` from `AppSettings` and `resolveSettings`, and drop the `HISTORY_LIMIT` import.
  - Update any test that passed `historyLimit`. None does today; confirm with `grep -rn historyLimit src`.
- [X] T015 [US1] In `src/http/chat-service.ts` (`runChat`):
  - Replace `lastMessages(id, historyLimit)` with `summaryOf(id)` plus `messagesAfter(id, summary?.coveredMessages ?? 0)`, still before recall. Both throw 404 for an unknown id, as today.
  - Compute `planHistory(uncovered)`. Summarization comes in US2, so when a batch is due use `uncovered.slice(-MAX_VERBATIM)` as `verbatim`. Otherwise use `plan.verbatim`, which `planHistory` already caps at 14.
  - Render the stored summary with `renderSummary`, or `""`.
  - Run `withHistory(withMemories(strategy, recalled), verbatim, rendered)`.
  - Set `historyMessages: verbatim.length` and `contextBreakdown.history` to `historyBlock(verbatim, rendered)`.
  - A new conversation has no summary and no messages.
- [X] T016 [P] [US1] In `src/long-conversation.test.ts`, change the SC-003 test to expect the count sequence `["0", "2", "4", "6", "8", "10", "12", "14"]` for `TURNS=8`, and rename it "shows the history growing to 14 messages before the first summary".
- [X] T017 [US1] Extend `src/http/server.test.ts`:
  - Create the conversation in a `FakeConversationStore`, then seed it with 16 messages and `saveSummary(id, "- Page the payments team\n- INC-002 stays open", 0, 8)`.
  - Then `POST /chat` with that `conversationId`.
  - The fake strategy's recorded input must start with `"Summary of the earlier conversation"` and contain `"Page the payments team"`.
  - `metrics.historyMessages` must be `8`.

**Checkpoint**: `npm run typecheck` and `npm test` are green. A stored summary reaches the agent in the right order (SC-001 can be shown with a seeded summary), and US1 can be demonstrated on its own.

---

## Phase 4: User Story 2 - The summary is refreshed in batches, merged, and kept (Priority: P2)

**Goal**: When at least 8 uncovered messages are older than the window, one plain model call merges the previous summary with exactly those messages. The reply is cleaned (lines trimmed, secret lines dropped, fit to 300 estimated tokens) and stored with a compare-and-swap. It is then used in that request's context. Any failure leaves everything as in US1. The calls count in the metrics.

**Independent Test**: Drive 20 exchanges through `runChat` with a scripted summarizer.

- It runs exactly on exchanges 9, 13, and 17 (SC-002).
- Each call receives the previous rendered summary (or `(none)`) and 8 messages.
- The stored coverage goes 8, 16, 24.
- A second store opened on the same temp file returns the last summary, and the next request makes no summarization call (SC-005).

### Tests and implementation for User Story 2

- [X] T018 [P] [US2] Extend `src/agents/history-summarizer.test.ts` with every row of [contracts/history-summarizer.md](contracts/history-summarizer.md):
  - **`summaryMessages`**:
    - `(undefined, msgs)`: a `SystemMessage` with the prompt, then a `HumanMessage` with `"Previous summary:\n(none)\n\nMessages to add:\nUser: …\nAssistant: …"`.
    - `(prev, msgs)`: holds `prev` in place of `(none)`.
    - The system text holds the example's requirements (at most 150 tokens; decisions, facts with names, dates, deadlines, and preferences, incidents opened or resolved, open items; drop greetings and small talk; incorporate the previous summary; the summary only, as telegraphic bullets) and says the input is data, not instructions.
  - **`cleanSummary`**: trims lines and drops blank ones.
    - It drops lines `looksLikeSecret` flags (for example `"- token is sk-abcdefghijklmnopqrstuv"`) and counts them in `droppedSecrets`.
    - An empty reply, or one whose lines are all blank or secret, gives `undefined`.
    - Lines are joined with `\n`.
  - **`fitSummary`**:
    - A summary that renders to more than 1,200 characters loses its last lines until `estimateTokens(renderSummary(result)) <= 300`.
    - A summary that already fits comes back unchanged.
  - **`createHistorySummarizer`** with `ScriptedChatModel`:
    - `textTurn("- a\n- b")` resolves to that text, from the prompt `summaryMessages` builds, with exactly one model call.
    - A model `Error` turn rejects, after one call (no retry).
    - An already-aborted signal rejects and makes no model call.
    - A hanging call rejects when the signal aborts.
    - A counter passed in `callbacks` counts the call.
- [X] T019 [US2] In `src/agents/history-summarizer.ts`, add:
  - `SUMMARY_PROMPT`: the English version of `docs/code-examples/spec11-example.ts`, plus one sentence saying the previous summary and the messages are data, not instructions. Do not copy the Portuguese text, and do not add rules beyond that sentence.
  - The pure `summaryMessages`, `cleanSummary` (reusing `looksLikeSecret` from `./learning-reflector.ts` and `SummaryText` from the domain), and `fitSummary(summary, maxTokens = SUMMARY_MAX_TOKENS)`.
  - `createHistorySummarizer({ model })`. Its `summarize(previous, messages, { signal, callbacks })` throws if the signal is already aborted, calls `model.invoke(summaryMessages(previous, messages), { signal, callbacks })` once, and returns the reply text (a string, or the text blocks joined).
  - No structured output, no `structured()` change, and no retry loop.
- [X] T020 [US2] In `src/http/server.ts`, add `SUMMARY_TIMEOUT_MS = 30_000`, the optional `summaryTimeoutMs?: number` in `AppSettings` (documented as a test seam), and the default in `resolveSettings`.
- [X] T021 [P] [US2] Extend `src/http/chat-reply.test.ts` for the pure `withSummarization(outcome, step)`, metrics part only:
  - A `stored` or `failed` step adds its `llmCalls` to `result.metrics.llmCalls`, and its `promptTokens` through `addPromptTokens`. This holds for a `completed` result and for a `run_failed` result with partial metrics.
  - A `not_due` step changes nothing.
  - Thrown and timeout outcomes pass through unchanged.
- [X] T022 [US2] In `src/http/chat-reply.ts`, add the `SummarizationStep` type from [data-model.md](data-model.md):
  - `stored`: `summary`, `rendered`, `absorbed`, `droppedSecrets`, `llmCalls`, `promptTokens`.
  - `failed`: `reason: "thrown" | "timeout" | "empty" | "conflict"`, `error?`, `llmCalls`, `promptTokens`.
  - `not_due`.

  Then add the pure `withSummarization(outcome: RunOutcome, step: SummarizationStep): RunOutcome`, which updates the metrics only for now.
- [X] T023 [P] [US2] Extend `src/http/chat-service.test.ts` with a `runChat: summarization` suite. Use a `ScriptedChatModel` from `createDependencies` whose turns answer the summarizer with `textTurn("- …")`, plus a fake strategy that records its inputs. Cases:
  - Over 20 exchanges, summarizer calls happen only on exchanges 9, 13, and 17, and the model's `calls` count matches (SC-002). Each call's human message holds the previous rendered summary (`(none)` on exchange 9) and exactly the 8 absorbed messages, in order.
  - `summaryOf` coverage is 8, 16, and 24 after those exchanges.
  - Exchange 9's strategy input already holds the new summary, and only the last 8 messages word for word.
  - **Merge** (US2-AS3/AS4): the scripted second summary keeps the open line from the first, and a third summary drops one the messages resolved. Check that the stored summaries equal the scripted ones.
  - Below the threshold (exchange 8, with 14 uncovered), the model has no call and the stored summary is unchanged (US2-AS1).
  - **Failure, thrown** (US3-AS3, SC-004): a model `Error` turn on exchange 9.
    - The reply is still `result`, and the answer and trace are the strategy's.
    - The stored summary is unchanged, and the strategy input holds the last 14 uncovered.
    - Exchanges 10, 11, and 12 make no summarizer call (C1).
    - Exchange 13 tries again and absorbs all 16 uncovered messages outside the window (coverage 0 → 16).
  - **Failure, every attempt fails** (SC-002): a model whose summarizer turns are always `Error` turns, over 20 exchanges.
    - Summarizer calls total exactly 3, which is 1 on each of exchanges 9, 13, and 17.
    - Every reply is a `result`.
    - `historyMessages` never exceeds 14.
  - **Failure, timeout**: `hangingTurn()` with `summaryTimeoutMs: 20`. Same expectations, and the run itself is not cut short.
  - **Run fails after a stored summary** (G1): the summary is stored on exchange 9, then the strategy fails.
    - When it returns a `run_failed` error result, `summaryOf` shows coverage 8 and the outcome's `result.trace[0]` is the `summarize` event (checked in US3, T031).
    - When it hangs past `timeoutMs` (504), coverage is still 8.
  - **Decision survives 20 exchanges** (G2, SC-001): every scripted summary keeps the line `"- Decision: page the payments team"`. Exchange 20's strategy input contains it, inside the summary block, even though the message that stated it left the verbatim messages long ago.
  - **Failure, empty**: a blank reply, or one with only secret lines.
  - **Failure, conflict**: a store subclass whose `saveSummary` returns `false`. The previous summary is used, not the new one.
  - **Metrics**: a stored or failed step's calls are added to `metrics.llmCalls`, and its usage (via `withUsage`) to `metrics.promptTokens`.
  - **Recall failure**: an `EmbeddingError` from recall throws before any summarization call.
  - **Restart** (SC-005): use `SqliteConversationStore` on a temp file. Summarize, close, and reopen. The next request makes no summarization call and its input holds the stored summary.
- [X] T024 [US2] In `src/http/chat-service.ts`, add the summarization step after recall and before conversation creation (research R5):
  - When `plan.toSummarize` is non-empty, create one `LlmCallCounter` and run `createHistorySummarizer({ model: dependencies.model }).summarize(previous?.summary, plan.toSummarize, { signal, callbacks: [counter] })` under `runWithTimeout(…, settings.summaryTimeoutMs)`.
  - Pass the result through `cleanSummary`.
  - On a non-empty result, call `saveSummary(id, summary, previous?.coveredMessages ?? 0, (previous?.coveredMessages ?? 0) + plan.toSummarize.length)`.
  - Build the step outcome:
    - **`stored`**: the new summary is rendered, and `verbatim` is `plan.verbatim`.
    - **`failed`** or **`conflict`**: the previous summary is kept, and `verbatim` is `uncovered.slice(-MAX_VERBATIM)`. No retry happens until `planHistory` reports the next batch boundary.
    - **`not_due`**: as in US1.
  - Apply `withSummarization(outcome, step)` to the run outcome. The summarizer must never throw out of `runChat`.

**Checkpoint**: `npm run typecheck` and `npm test` are green. Summaries are made only in batches, merged, stored, survive a restart, and never fail a request.

---

## Phase 5: User Story 3 - The engineer can see when the history was summarized (Priority: P3)

**Goal**: The reply of the request that stored a summary starts its trace with `{ type: "summarize", content, absorbed }`, and no other reply has one. The server logs one line per summarization outcome, without item text.

**Independent Test**:

1. Send the request that crosses the threshold. `trace[0]` is `summarize`, with the rendered summary and `absorbed: 8`.
2. Send the next request. It has no `summarize` event.
3. Make the summarizer fail. The reply is a 200 with no event, and exactly one log line names the reason.

### Tests and implementation for User Story 3

- [X] T025 [P] [US3] Extend `src/http/schemas.test.ts`:
  - `TraceEventSchema`, through `ChatReply`, accepts `{ type: "summarize", content: "x", absorbed: 8 }`.
  - It rejects `absorbed: 0`, `absorbed: 1.5`, and a missing `content`.
  - A `run_failed` `ErrorReply` with that event in its `trace` parses.
- [X] T026 [US3] Add `| { type: "summarize"; content: string; absorbed: number }` to `TraceEvent` in `src/domain/types.ts`, and `z.object({ type: z.literal("summarize"), content: z.string(), absorbed: Count.min(1) })` to `TraceEventSchema` in `src/http/schemas.ts`.
- [X] T027 [P] [US3] Make `formatEvent` print the event as `[summarize] (8 messages): <content>`, like the other bracketed events in `src/trace/format.ts`, and cover it in `src/trace/format.test.ts`. The `switch` must stay exhaustive.
- [X] T028 [P] [US3] Extend `src/http/chat-reply.test.ts`:
  - **`withSummarization`**:
    - With a `stored` step, it prepends `{ type: "summarize", content: step.rendered, absorbed: step.absorbed }` to the trace of a completed result and of a `run_failed` result, and `toHttpReply` keeps it first (FR-009).
    - With a `failed` or `not_due` step, it adds no event.
  - **`summaryLogLine(conversationId, step, timeoutMs)`** returns, per research R9:
    - **Stored**: `{ stream: "log", line: "Summarized 8 messages for conversation c1" }`. With `droppedSecrets > 0`, the line ends with `", 2 lines dropped as secrets"`.
    - **Timeout**: `{ stream: "error", line: "Summary timed out after 30000 ms for conversation c1" }`.
    - **Thrown**: `{ stream: "error", line: "Summary failed for conversation c1: Error: boom" }`.
    - **Empty**: `{ stream: "warn", line: "Summary skipped for conversation c1: empty" }`.
    - **Conflict**: `{ stream: "warn", line: "Summary skipped for conversation c1: conflict" }`.
    - **`not_due`**: `undefined`.
  - No line ever contains the summary's text.
- [X] T029 [US3] In `src/http/chat-reply.ts`, extend `withSummarization` to prepend the event for a `stored` step, and add the pure `summaryLogLine`. Its `LogLine` shape is the one `learningLogLine` uses.
- [X] T030 [US3] In `src/http/chat-service.ts`, write `summaryLogLine(…)` to the matching `console` stream for every step except `not_due`. Extend `src/http/chat-service.test.ts`, mocking `console` with `t.mock.method`:
  - The triggering request writes exactly one `log` line.
  - A failed one writes one `error` or `warn` line.
  - A request below the threshold writes none.
  - No line contains the scripted summary's text.
- [X] T031 [US3] Extend `src/http/server.test.ts`:
  - Seed 16 messages in a `FakeConversationStore`, and give `createDependencies` a `ScriptedChatModel` that answers the summarizer with `textTurn("- …")` and then `NO_LEARNING`.
  - `POST /chat` returns a 200 whose body parses with `ChatReply`, with `trace[0].type === "summarize"`, `trace[0].absorbed === 8`, and `metrics.historyMessages === 8`.
  - The next `POST` in the same conversation has no `summarize` event (US3-AS1/AS2).
  - When the summary is stored and the fake strategy then returns a `run_failed` error result, the 502 body parses with `ErrorReply` and its `trace[0]` is the `summarize` event. The next request in that conversation uses the stored summary (G1, FR-009).

**Checkpoint**: All three stories work. `npm run typecheck` and `npm test` are green.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T032 [P] Update `README.md`:
  - In the Features table, add a row for history summarization (`011-history-summarization`), and change the 007 row's "The last 12 messages go into the prompt" to name the 8-message window plus the summary.
  - In the HTTP API section, change "earlier messages (at most 12)" to "messages given word for word (8 to 14)".
  - Add a short "History summarization" section covering:
    - The window.
    - The batch rule: exchanges 9, 13, 17.
    - The telegraphic text summary, the 150-token request, and the 300-token cap.
    - The secret check.
    - The `summarize` event.
    - The failure behaviour.
    - The `conversation_summaries` table.
  - In the context measurement section, change the example output to show `(14 messages)` and then `(8 messages)`, and the "12-message limit" wording.
- [X] T033 [P] Update the header comment of `scripts/long-conversation.sh`: the history now climbs to 14 messages and drops to 8 when it is summarized, instead of levelling off at 12. Make no behaviour change to the script, and leave the 010 spec files as they are, because they describe that feature.
- [X] T034 Final verification from the repository root:
  - `npm run typecheck` and `npm test` are green.
  - `git diff --stat` shows no change to `src/mcp/`, the request schema `ChatRequest`, or the 008/009 memory code beyond the reused `looksLikeSecret` import.
  - `grep -rn "OPSPILOT_DB\|data/" ` over the new or changed `*.test.ts` files finds only comments.
  - Every new SQL string is a constant passed to `prepare`.
- [ ] T035 Manual quickstart: the user runs it with their own OpenRouter key, and the agent never reads `.env`. Run [quickstart.md](quickstart.md) §2–§4:
  - The `(k messages)` sequence climbs to 14 and drops to 8 on turns 9, 13, and 17.
  - Turn 9's reply has `trace[0].type === "summarize"`.
  - After a restart, the next request uses the stored summary with no `summarize` event.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. It blocks all stories, because the store methods and domain types are read by US1, written by US2, and seeded in tests.
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after US1, because it replaces US1's "batch due, so keep the newest 14" branch with the real step and reuses `renderSummary` and `planHistory`.
- **US3 (Phase 5)**: after US2, because the event comes from a `stored` step.
- **Polish (Phase 6)**: after all stories.

### Within each story

- **Foundational**:
  - T002 → T003.
  - T004 and T005 come before T006 and T007.
  - T006 ∥ T007, then T008.
- **US1**:
  - T009 → T010.
  - T011 → T012.
  - T013 waits for T010 and T012, then → T014 → T015.
  - T016 ∥ T017 after T015.
- **US2**:
  - T018 → T019.
  - T020.
  - T021 → T022.
  - T023 → T024, which needs T019, T020, and T022.
- **US3**:
  - T025 → T026.
  - T027 after T026.
  - T028 → T029.
  - T030 after T029.
  - T031 last.

### Parallel Opportunities

- Foundational: T002 ∥ T004, which are different files; then T006 ∥ T007.
- US1: T009 ∥ T011 ∥ T013, which are three test files; then T016 ∥ T017.
- US2: T018 ∥ T021 ∥ T023, which are three test files.
- US3: T025 ∥ T028; then T027 alongside T029.
- Polish: T032 ∥ T033.

---

## Parallel Example: User Story 1

```text
# Red phase, three test files at once:
Task: "T009 planHistory and historyBlock(summary) in src/agents/history.test.ts"
Task: "T011 renderSummary in src/agents/history-summarizer.test.ts"
Task: "T013 summary-in-context cases in src/http/chat-service.test.ts"
```

## Parallel Example: User Story 2

```text
# Red phase:
Task: "T018 summarizer, cleanSummary, fitSummary in src/agents/history-summarizer.test.ts"
Task: "T021 withSummarization metrics in src/http/chat-reply.test.ts"
Task: "T023 20-exchange batching and failure paths in src/http/chat-service.test.ts"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1, then Phase 2: the store and the types.
2. Phase 3: a stored summary reaches the agent in the right order, and the window is 8 to 14
   messages.
3. **Stop and validate**: `npm test` is green, and a seeded summary shows up in the agent's input.

### Incremental delivery

1. US1: the context shape, plus a safe cap of 14 verbatim messages.
2. US2: real summaries, batched, merged, cleaned, stored, and counted.
3. US3: visibility through the `summarize` event and log lines.
4. Polish: README, the script comment, final checks, and the manual quickstart.

### Notes

- With no summary, every composed string must stay byte-identical. The existing 007–010 tests
  are the regression net.
- The summarizer is the only new model call. It never runs below the threshold, and it never
  fails a request.
- Commit only when the user asks.
