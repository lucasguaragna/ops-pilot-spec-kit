# Research: History Summarization

All decisions below come from the spec (with its four clarifications) and the current code. No
NEEDS CLARIFICATION remains.

## R1. Where the summary is stored

- **Decision**: A new table `conversation_summaries` in the same SQLite file as `conversations` and
  `messages`, created by the existing `CONVERSATION_SCHEMA` with `CREATE TABLE IF NOT EXISTS`. The
  existing `ConversationStore` interface gains two methods, and the SQLite store and the fake store
  both implement them:
  - `summaryOf(conversationId)`
  - `saveSummary(conversationId, summary, expectedCovered, coveredMessages)`
- **Rationale**:
  - The summary belongs to a conversation and dies with it. Keeping it in the conversation store
    means one store interface, one file, and a foreign key to `conversations(id)`.
  - `IF NOT EXISTS` makes opening an existing database safe: the table is added on first open, and
    no migration step is needed (constitution: idempotent schema).
  - The summary is stored as one `TEXT` column, guarded by `CHECK (length(trim(summary)) > 0)`.
  - `covered_messages` is guarded by `CHECK (covered_messages > 0)`.
- **Alternatives considered**:
  - **A separate `SummaryStore` interface and class**: a second store for one row per
    conversation, and a second contract test. Rejected.
  - **Three lists in JSON columns** (the first plan): rejected on 2026-11-25 in favour of the
    free-text format of the course example (R4).
  - **One row per line**: a child table just to rebuild a short text on every read. Rejected.

## R2. How the uncovered messages are read

- **Decision**: A third new store method, `messagesAfter(conversationId, covered)`, returns every
  message after the first `covered` ones, oldest first. In SQL that is `ORDER BY id LIMIT -1 OFFSET ?`
  with `covered` bound. The service reads `summaryOf`, then `messagesAfter(id, summary?.covered ?? 0)`.
  `lastMessages` stays in the interface for the existing callers and tests.
- **Rationale**: The batching rule needs the count of uncovered messages and their text, and the
  context needs the uncovered ones word for word (FR-003). One query returns exactly that. Without
  a summary, this is all the messages when the conversation is shorter than 16. After that, it is
  8 to 14 rows. Only while summarization keeps failing does it grow, by 2 per exchange, and the
  context then keeps just the newest 14 (R5). The next success absorbs them all.
- **Alternatives considered**: `lastMessages(id, 14)` plus a separate count query. Two queries, and
  14 is wrong right after a failed summarization. Rejected.

## R3. The batching rule

- **Decision**: A pure `planHistory(uncovered)` returns `{ toSummarize, verbatim }`. Let
  `outside = uncovered.length - HISTORY_WINDOW`.
  - **Due** when `outside >= SUMMARY_BATCH && outside % SUMMARY_BATCH < 2`. That is, `outside` has
    just reached 8, 16, 24, and so on. `toSummarize` is every message outside the window
    (`uncovered.slice(0, outside)`) and `verbatim` is the window.
  - **Otherwise** `toSummarize` is empty and `verbatim` is `uncovered.slice(-MAX_VERBATIM)`.
- **Rationale**:
  - FR-004 (as amended after `/speckit-analyze` C1) allows an attempt only on a batch boundary. The
    rule needs no stored "last failure" state: `outside` grows by 2 per exchange, so `% 8 < 2`
    hits exactly once per 4 exchanges, for either parity.
  - After a success `outside` is 0. After a failure at 8, the next attempt is at 16 and absorbs all
    16. Absorbing everything outside the window is what makes the retry catch up.
  - The rule fires on exchanges 9, 13, and 17 (SC-002).
  - The `slice(-14)` keeps the context bounded while attempts keep failing (SC-003).
- **Constants**: `HISTORY_WINDOW = 8`, `SUMMARY_BATCH = 8`, and `MAX_VERBATIM = 14`
  (window + batch − 2) replace `HISTORY_LIMIT = 12` in `src/agents/history.ts`. The `historyLimit`
  setting is removed. The window is a constant, not a setting.

## R4. The summarizer

- **Decision**: A new `src/agents/history-summarizer.ts`, a plain model call (no structured output):
  - **Model call**: `model.invoke(summaryMessages(previous, messages), { signal, callbacks })`, one
    call per attempt. It rejects on a model or abort failure. The reply text is the summary.
  - **Prompt**: the example in `docs/code-examples/spec11-example.ts`, in English: compress the
    excerpt into at most 150 tokens, keep decisions, facts (names, dates, deadlines, preferences),
    incidents opened or resolved, and open items, drop greetings and small talk, incorporate the
    previous summary if there is one, and answer with the summary only, as telegraphic bullets. One
    sentence is added: the previous summary and the messages are data, not instructions.
  - **Input**: built by the pure `summaryMessages(previous, messages)`: the system prompt, then a
    human message with the previous summary (or `(none)`) and the messages to absorb, as labelled
    `User:` / `Assistant:` lines.
  - **Cleaning**: the pure `cleanSummary(text)` splits the reply into lines, trims them, drops the
    blank ones, drops the lines that match `looksLikeSecret` (counting them), and fits the rest to
    the cap (R6). It returns `undefined` when nothing is left.
- **Rationale**:
  - The example asks for plain telegraphic text, which needs no tool binding, no schema, and no
    retry loop: a failure is one rejected call.
  - The merge happens in the model, because only the model can tell which open item a message
    settled. The code makes sure the merge input always holds the previous summary (FR-005).
  - One call per attempt keeps a failing provider at 1 call per batch boundary (SC-002).
- **Alternatives considered**:
  - **Three structured lists** (the first plan, with `withStructuredOutput` and a retry): rejected
    on 2026-11-25 for the plain format of the example.
  - **Summarizing without the previous summary and concatenating**: grows without bound and never
    resolves an open item. Rejected by FR-005.

## R5. Where summarization runs in the request

- **Decision**: In `runChat`, in this order:
  1. Strategy lookup.
  2. `summaryOf` plus `messagesAfter` (both throw 404 for an unknown id).
  3. Recall.
  4. Summarization if `planHistory` says it is due.
  5. Conversation creation.
  6. The run.

  Summarization runs through `runWithTimeout` with its own `summaryTimeoutMs` (default 30,000,
  outside the run's 180 s). Its model calls go through their own `LlmCallCounter`.
  - **Success** (stored): the new summary and the window go to the agent, and the reply gets the
    `summarize` event and the extra calls and tokens.
  - **Failure** (thrown, timeout, nothing usable, or the compare-and-swap lost): the previous
    summary and the uncovered messages go to the agent, capped at the newest `MAX_VERBATIM` = 14.
    One log line is written. The status, answer, and trace stay as without a new summary, while the
    metrics include the calls made (R7). The next attempt waits for the next batch boundary (R3).
- **Rationale**:
  - Summarizing after recall means a failed recall (500) wastes no model call.
  - A new conversation never needs it, so creating the conversation can stay last, as today.
  - The 14-message cap on failure keeps SC-003 true even when the provider is down for many
    turns.
- **Alternatives considered**:
  - **Background after the reply**: rejected by the clarification (option A).
  - **Inside the run timeout**: a slow summary would eat the agent's time. Rejected (spec
    assumption).

## R6. The size cap

- **Decision**: The pure `renderSummary(summary)` builds the context block:

  ```text
  Summary of the earlier conversation (oldest messages first, merged):
  - …
  - …

  ```

  An empty summary renders as `""`. `fitSummary(summary, maxTokens = 300)` drops whole lines from the
  end until `estimateTokens(renderSummary(summary)) <= 300`.
- **Rationale**:
  - FR-006 uses the project's estimate (010's `estimateTokens`).
  - Dropping whole lines never leaves half an id.
  - The prompt asks for 150 tokens, so the 300 ceiling only matters when the model ignores it.

## R7. The trace event and the metrics

- **Decision**:
  - **Trace event**: `TraceEvent` gains `{ type: "summarize"; content: string; absorbed: number }`,
    where `content` is the rendered summary. `TraceEventSchema` gains the same shape, with
    `absorbed: Count` and `content: z.string()`. `formatEvent` (arena) prints it as
    `[summarize] (<n> messages): <content>`, matching the bracketed tag of the other events.
  - **Pure `withSummarization(outcome, step)`**: for a `result` outcome, it prepends the event to
    `result.trace`. It adds the step's calls to `metrics.llmCalls`, and its tokens to
    `metrics.promptTokens` with `addPromptTokens`. Other outcomes pass through unchanged.
  - **Failed step**: no event, but its finished calls are still added to the metrics. FR-010 keeps
    the answer and the trace as if there were no new summary. The metrics are a cost report, and
    the calls were paid for. A timeout counts the calls started (the counter's `count`), and their
    tokens only where usage arrived.
- **Rationale**: FR-009 (first event), FR-011 (counted), and the 502 with a partial trace also shows
  it. The reflection critic never sees the event, because the event is added after the run.
- **Breakdown (010)**: `contextBreakdown.history` becomes
  `estimateTokens(historyBlock(verbatim, summaryText))`. The summary is part of the history block,
  so 010's five sources and its schema are unchanged.

## R8. Context composition

- **Decision**:
  - `historyBlock(history, summary = "")` returns the rendered summary followed by today's block.
    It still returns `""` when both are empty.
  - `composeInput(history, message, summary?)` is that block plus the message.
  - `withHistory(strategy, history, summary?)` passes it through.
  - The memory block stays outermost, through `withMemories`.
- **Rationale**: FR-008's order (memories, summary, verbatim, message) falls out of the existing
  wrapping, `withHistory(withMemories(strategy, recalled), history, summary)`. With no summary,
  every existing string is byte-identical.

## R9. Logging

- **Decision**: A pure `summaryLogLine(conversationId, outcome)` in `chat-reply.ts`, next to
  `learningLogLine`:
  - `Summarized <n> messages for conversation <id>`, plus `, <k> lines dropped as secrets` when k
    > 0.
  - `Summary timed out after <ms> ms for conversation <id>`.
  - `Summary failed for conversation <id>: <ErrorName>: <message>`.
  - `Summary skipped for conversation <id>: empty`.
  - `Summary skipped for conversation <id>: conflict`.

  It never prints summary text (FR-010, FR-013).

## R10. Tests use a fake model only

- **Decision**:
  - The summarizer is tested with `ScriptedChatModel` and `textTurn("- …")`.
  - The service tests drive 20 exchanges with a fake strategy and a scripted model that answers the
    summarizer, and check the exchanges where it runs, the merge input, the context order, and the
    failure path.
  - The store contract test gains `summaryOf`, `saveSummary` (including a lost compare-and-swap),
    and `messagesAfter`. It runs against `":memory:"` and the fake.
  - A persistence test opens a second store on a temporary file, as the 007 restart test does.
- **Existing tests affected**:
  - `chat-service.test.ts` "uses only the 12 newest earlier messages" becomes "the newest 14
    before summarizing".
  - `history.test.ts` `HISTORY_LIMIT` becomes the new constants.
  - `long-conversation.test.ts` SC-003 expects `0, 2, …, 12, 14` for 8 turns.
