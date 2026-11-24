---

description: "Task list for 010 Context Measurement"
---

# Tasks: Context Measurement

**Input**: Design documents from `specs/010-context-measurement/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. The feature input says "With tests", and FR-012 and SC-005 require tests
that use a fake model, never the real provider. Within each story, write the test tasks first and
see them fail, then implement.

**Organization**: Tasks are grouped by user story, so each story can be implemented and tested on
its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Path Conventions

Single project: `src/` and its co-located `*.test.ts` files (run by the `src/**/*.test.ts` glob),
plus the new top-level `scripts/` directory.

Standing rules for every task:

- Tests never open, create, or change the database at `OPSPILOT_DB` or anything under `data/`.
  Use the fake stores, `":memory:"`, and `ScriptedChatModel`.
- Never read `.env`.
- New logic is a pure function wherever possible.
- `npm run typecheck` and `npm test` are green at each checkpoint.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the baseline before changing shared types.

- [X] T001 Run `npm run typecheck` and `npm test` from the repository root and confirm both are green before any change (baseline for SC-005)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure token helpers that US1 (usage sum) and US2 (estimates) both need.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Write `src/context/tokens.test.ts` covering every row of the `tokens.ts` table in [contracts/context-module.md](contracts/context-module.md).
  - `estimateTokens`:
    - `""` gives 0, `"a"` gives 1, `"abcd"` gives 1, `"abcde"` gives 2, `"x".repeat(400)` gives 100.
    - A 100,000-character string does not throw.
  - `promptTokensOf` on hand-built `LLMResult` objects:
    - A `ChatGeneration` whose `message` is an `AIMessage` with `usage_metadata: { input_tokens: 120, output_tokens: 5, total_tokens: 125 }` gives 120.
    - Two such generations give their sum.
    - No `usage_metadata` gives `undefined`.
    - `input_tokens` of `-1`, `1.5`, or `NaN` gives `undefined`.
    - `{ generations: [] }` gives `undefined`.
  - `addPromptTokens`:
    - `(null, undefined)` gives `null`, `(null, 0)` gives `0`, `(100, null)` gives `100`, `(100, 50)` gives `150`.
- [X] T003 Implement `src/context/tokens.ts` exactly as specified in [contracts/context-module.md](contracts/context-module.md) and [data-model.md](data-model.md):
  - `estimateTokens(text: string): number` returns `Math.ceil(text.length / 4)`.
  - `promptTokensOf(output: LLMResult): number | undefined` sums `usage_metadata.input_tokens` over `output.generations.flat()` entries that have a `message`, counting only values that pass `Number.isInteger(n) && n >= 0`.
  - `addPromptTokens(total: number | null, more: number | null | undefined): number | null` follows the summing table in data-model.md.
  - Import `LLMResult` as a type from `@langchain/core/outputs`. The module is pure, with no store, HTTP, or model import.

**Checkpoint**: `node --import tsx --test src/context/tokens.test.ts` passes.

---

## Phase 3: User Story 1 - The engineer sees how many prompt tokens a reply really cost (Priority: P1) 🎯 MVP

**Goal**: Every run's metrics carry `promptTokens`, the provider-reported input tokens summed over every model call of the run. It is `null` when no call reported usage. `/chat` 200 and `run_failed` 502 (with partial metrics) expose it.

**Independent Test**: A run against `ScriptedChatModel` that reports 100, 150, and 200 input tokens over 3 calls yields `metrics.promptTokens === 450`. With no usage on any call it yields `null`, and the reply is still a 200.

### Tests and implementation for User Story 1

- [X] T004 [P] [US1] Extend `src/testing/scripted-chat-model.test.ts`:
  - A turn built with the new `withUsage(textTurn("hi"), 120)` returns a chunk or message whose `usage_metadata.input_tokens` is 120.
  - A callback handler passed in `callbacks` receives `handleLLMEnd` with an output where `promptTokensOf(output) === 120`.
  - A turn without usage yields `promptTokensOf(output) === undefined`.
- [X] T005 [US1] In `src/testing/scripted-chat-model.ts`, copy a scripted `AIMessage` turn's `usage_metadata` onto the message or chunk the model returns (research R8). Also export `withUsage(turn: AIMessage, inputTokens: number): AIMessage`:
  - It returns a copy of `turn` with `usage_metadata: { input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens }`.
  - It keeps the content and `tool_calls`.
- [X] T006 [P] [US1] Extend `src/agents/llm-counter.test.ts`:
  - A new `LlmCallCounter` has `promptTokens === null`.
  - After `handleLLMEnd` with outputs of 100 and 50 input tokens, `promptTokens === 150`.
  - With an output carrying 100 and one carrying no usage, the result is 100 (partial edge case).
  - With only outputs carrying no usage, it stays `null`.
  - `count` behaviour (+1 per `handleChatModelStart`) is unchanged.
- [X] T007 [US1] In `src/agents/llm-counter.ts`, add `promptTokens: number | null = null` and a `handleLLMEnd(output: LLMResult)` that sets `this.promptTokens = addPromptTokens(this.promptTokens, promptTokensOf(output))`. Keep the class name, `count`, `handleChatModelStart`, and `awaitHandlers = true` (research R2).
- [X] T008 [US1] In `src/domain/types.ts`, add the required field `promptTokens: number | null` to `Metrics`, with a doc comment: "Sum of `usage_metadata.input_tokens` over every model call of the run that finished and reported usage. `null` when none did." Do not make it optional (research R6).
- [X] T009 [P] [US1] Extend `src/agents/react.test.ts`, using `ScriptedChatModel` with `withUsage`:
  - A run whose 3 model calls report 100, 150, and 200 gives `metrics.promptTokens === 450` and the same `llmCalls`, answer, trace, and stop reason as without usage (FR-009).
  - With no usage on any call, the result is `null`.
  - An error result (`run_failed`) after 2 calls that reported usage carries the sum of those 2 calls.
- [X] T010 [P] [US1] Extend `src/agents/plan-and-execute.test.ts`:
  - Scripted usage on the planner, executor, and replanner calls gives `metrics.promptTokens` equal to their sum.
  - Compared with the same script without usage, `llmCalls`, answer, trace, and stop reason are the same (FR-009).
  - With no usage, the result is `null`.
- [X] T011 [P] [US1] Extend `src/agents/reflection.test.ts`:
  - `promptTokens` equals the sum of the attempts' `promptTokens` plus the critic call's input tokens (spec US1-AS4).
  - The rewrite attempt's metrics carry `promptTokens: null`, because its call is counted in reflection's own counter.
  - When nothing reports usage, the result is `null`.
  - Compared with the same script without usage, `llmCalls`, answer, trace, and stop reason are the same (FR-009).
- [X] T012 [US1] In `src/agents/react.ts`, set `promptTokens: counter.promptTokens` on every `Metrics` object the strategy builds: success, error result, and any early return.
- [X] T013 [US1] In `src/agents/plan-and-execute.ts`, set `promptTokens: counter.promptTokens` on every `Metrics` object it builds, for both variants.
- [X] T014 [US1] In `src/agents/reflection.ts`, compute `promptTokens` as `addPromptTokens` folded over every attempt's `metrics.promptTokens`, then add the reflection counter's own `promptTokens`, mirroring how `llmCalls` uses `baseCalls` plus the counter. The rewrite attempt's metrics become `{ llmCalls: 0, latencyMs: 0, promptTokens: null }`.
- [X] T015 [US1] Add `promptTokens` to every remaining `Metrics` literal until `npm run typecheck` is green. Use `promptTokens: null` unless the test is about tokens.
  - Test files: `src/agents/history.test.ts`, `src/agents/index.test.ts`, `src/agents/memories.test.ts`, `src/agents/reflection.test.ts`, `src/bench.test.ts`, `src/http/chat-reply.test.ts`, `src/http/chat-service.test.ts`, `src/http/schemas.test.ts`, `src/http/server.test.ts`, `src/trace/format.test.ts`.
  - Also `src/bench.ts` and `src/trace/format.ts`, only where they build a `Metrics` literal. Do NOT change what `formatMetrics` prints or the bench rows (plan constraints).
- [X] T016 [P] [US1] Extend `src/http/schemas.test.ts`: `MetricsSchema` accepts `promptTokens: 450` and `promptTokens: null`, and rejects `-1`, `1.5`, `"450"`, and a missing `promptTokens`.
- [X] T017 [US1] In `src/http/schemas.ts`, add `promptTokens: Count.nullable()` to `MetricsSchema`. The existing fields `llmCalls`, `latencyMs`, `historyMessages`, and `recalledMemories` keep their meaning (FR-008).
- [X] T018 [P] [US1] Extend `src/http/chat-reply.test.ts`:
  - `toHttpReply` on a result whose metrics carry `promptTokens: 360` gives a 200 whose `metrics.promptTokens` is 360.
  - A `run_failed` error result with partial metrics carrying `promptTokens: 250` gives a 502 whose `metrics.promptTokens` is 250 (US1-AS3).
  - A thrown run and a timeout give replies with no `metrics` key (edge cases).
- [X] T019 [US1] Extend `src/http/server.test.ts`:
  - A `POST /chat` against a fake strategy whose metrics carry `promptTokens: 360` returns a 200 whose body parses with `ChatReply` and has `metrics.promptTokens === 360`.
  - A fake strategy returning `promptTokens: null` returns a 200 with `metrics.promptTokens === null` (US1-AS2).

**Checkpoint**: `npm run typecheck` and `npm test` are green. `/chat` replies carry the real `promptTokens`, and US1 can be demoed on its own (quickstart §2, first bullet).

---

## Phase 4: User Story 2 - The engineer sees which sources fill the context (Priority: P2)

**Goal**: `/chat` 200 and `run_failed` 502 (with partial metrics) carry `metrics.contextBreakdown`: `{ system, tools, history, memories, message, total }`. Each source is `estimateTokens` of the exact text the agent starts with, and `total` is their sum.

**Independent Test**: `contextBreakdown({ system: 400 chars, tools: 800 chars, history: 1000 chars, memories: "", message: 40 chars })` returns `{ system: 100, tools: 200, history: 250, memories: 0, message: 10, total: 560 }`.

### Tests and implementation for User Story 2

- [X] T020 [P] [US2] Write `src/context/breakdown.test.ts`:
  - The spec example gives a total of 560.
  - All five texts `""` give all zeros.
  - `total` equals the sum of the five for a mixed input, which is not necessarily `estimateTokens` of the concatenation.
  - `toolDefinitionsText([])` is `"[]"`.
  - `toolDefinitionsText` of the ops tools from `src/agents/tools.ts` parses as a JSON array with one entry per tool, each with `type: "function"` and a `function.name` matching the tool name, `function.description`, and `function.parameters`.
- [X] T021 [US2] Implement `src/context/breakdown.ts` per [contracts/context-module.md](contracts/context-module.md):
  - Export `ContextTexts` (`system`, `tools`, `history`, `memories`, `message`, all `string`) and `ContextBreakdown` (the same keys plus `total`, all `number`).
  - `contextBreakdown(texts)`: each field is `estimateTokens(texts.<field>)` and `total` is the sum of the five.
  - `toolDefinitionsText(tools: readonly StructuredToolInterface[])` returns `JSON.stringify(tools.map((t) => convertToOpenAITool(t)))`, with `convertToOpenAITool` from `@langchain/core/utils/function_calling`.
  - The module is pure.
- [X] T022 [US2] In `src/domain/types.ts`, add the optional `systemPrompt?: string` to `ReasoningStrategy`, documented as "The system instructions of the strategy's first model call; measured as 0 when absent." Existing fake strategies must keep compiling unchanged.
- [X] T023 [P] [US2] Extend `src/agents/history.test.ts`:
  - `historyBlock([])` is `""`.
  - For empty and non-empty history, `composeInput(h, m) === historyBlock(h) + m`, and the output is byte-identical to the current expectations.
  - `withHistory` over a strategy with `systemPrompt: "S"` exposes `systemPrompt === "S"`.
  - `withHistory` over a strategy without one has no `systemPrompt` key (`!("systemPrompt" in wrapped)`).
- [X] T024 [P] [US2] Extend `src/agents/memories.test.ts`:
  - `memoryBlock([])` is `""`.
  - For empty and non-empty memories, `composeMemoryInput(m, input) === memoryBlock(m) + input`, with output unchanged.
  - The `systemPrompt` pass-through and omission rules for `withMemories` are the same as in T023.
- [X] T025 [P] [US2] In `src/agents/history.ts`, export the pure `historyBlock(history: readonly NewMessage[]): string`.
  - It returns `""` for no history. Otherwise it returns everything `composeInput` adds ahead of the message (`"Conversation so far (oldest first):\n…\n\nCurrent request: "`).
  - Rewrite `composeInput` as `historyBlock(history) + message`.
  - Make `withHistory` copy the wrapped strategy's `systemPrompt` only when it has one.
- [X] T026 [P] [US2] In `src/agents/memories.ts`, export the pure `memoryBlock(memories: readonly Pick<Memory, "id" | "fact">[]): string`.
  - It returns `""` for no memories. Otherwise it returns everything `composeMemoryInput` adds ahead of the input.
  - Rewrite `composeMemoryInput` as `memoryBlock(memories) + input`.
  - Make `withMemories` copy `systemPrompt` only when present.
- [X] T027 [P] [US2] Extend the strategy `systemPrompt` tests:
  - `src/agents/react.test.ts`: the react strategy's `systemPrompt` equals the exported or module `SYSTEM_PROMPT`.
  - `src/agents/plan-and-execute.test.ts`: both variants' `systemPrompt` is the planner prompt with `{tools}` already replaced. It contains each tool name and no literal `{tools}`.
  - `src/agents/reflection.test.ts`: `reflect:*` exposes the base strategy's `systemPrompt`, or has no key when the base has none.
- [X] T028 [US2] Expose `systemPrompt` on the strategies built in `src/agents/react.ts` (`SYSTEM_PROMPT`), `src/agents/plan-and-execute.ts` (the filled `plannerPrompt`), and `src/agents/reflection.ts` (the base value, copied only when present). Follow the table in [data-model.md](data-model.md).
- [X] T029 [P] [US2] Extend `src/http/schemas.test.ts`:
  - `MetricsSchema` accepts a `contextBreakdown` whose `total` equals the sum of the five sources.
  - It rejects one where `total` differs, with the issue at `path: ["contextBreakdown", "total"]` and message "total must equal the sum of the sources".
  - It rejects a negative or fractional source and a missing `contextBreakdown`.
- [X] T030 [US2] In `src/http/schemas.ts`, add `ContextBreakdownSchema` exactly as in [contracts/chat-metrics.md](contracts/chat-metrics.md): every field is `Count`, with a `.refine` checking that `total === system + tools + history + memories + message`. Add `contextBreakdown: ContextBreakdownSchema` to `MetricsSchema`.
- [X] T031 [P] [US2] Extend `src/http/chat-reply.test.ts`:
  - Every `ChatOutcome` literal gains a `context: ContextBreakdown`.
  - A 200 reply's `metrics.contextBreakdown` deep-equals `outcome.context`, and so does a `run_failed` 502 with partial metrics (FR-007).
  - Thrown and timeout replies still carry no `metrics`.
- [X] T032 [US2] In `src/http/chat-reply.ts`, add `context: ContextBreakdown` to `ChatOutcome`, and make `contextMetrics(outcome)` also return `contextBreakdown: outcome.context` (research R5).
- [X] T033 [P] [US2] Extend `src/http/chat-service.test.ts`, using fake stores, a fake embedder, and a fake strategy that records the input string it receives:
  - No `conversationId` and no `userId`: `context.history === 0`, `context.memories === 0`, `context.message === estimateTokens(message)`, and `context.tools > 0` (US2-AS1).
  - A conversation with 6 earlier messages: `context.history === estimateTokens(historyBlock(those 6))` (US2-AS2).
  - A `userId` with 3 recalled memories: `context.memories === estimateTokens(memoryBlock(recalled))`, and `context.tools` includes the memory tools, so it is larger than without `userId` (US2-AS3).
  - The recorded strategy input equals `memoryBlock(recalled) + historyBlock(history) + message` (data-model invariant).
  - A strategy with `systemPrompt: "x".repeat(400)` gives `context.system === 100`, and one without gives 0.
  - One case runs through the real `react` strategy over `ScriptedChatModel` (one `textTurn`), with the real ops tools from `src/agents/tools.ts` and no `conversationId` or `userId`. It checks US2-AS1 against real sources:
    - `context.system > 0` and equals `estimateTokens` of that strategy's `systemPrompt`.
    - `context.tools > 1`, because `"[]"` alone estimates to 1, so `> 0` would pass with no tools.
    - `context.message > 0`, `context.history === 0`, `context.memories === 0`.
  - `context` is set on result, thrown, and timeout outcomes.
- [X] T034 [US2] In `src/http/chat-service.ts` (`runChat`), build `ContextTexts` from the values it already holds:
  - `system`: `strategy.systemPrompt ?? ""`.
  - `tools`: `toolDefinitionsText(tools)`, the same tool list passed to the strategy, including the memory tools when `userId` is set.
  - `history`: `historyBlock(history)`.
  - `memories`: `memoryBlock(recalled)`.
  - `message`: `request.message`.
  - Set `context: contextBreakdown(texts)` on every `ChatOutcome` it returns. Make no extra model call (FR-009).
- [X] T035 [US2] Extend `src/http/server.test.ts`, and update any other `ChatOutcome` or metrics fixtures so typecheck passes:
  - A `POST /chat` 200 body parses with `ChatReply` and has `metrics.contextBreakdown` with `history: 0`, `memories: 0`, and `total` equal to the sum of the five sources.
  - A second turn in the same conversation has `contextBreakdown.history > 0` and `historyMessages: 2`.

**Checkpoint**: `npm run typecheck` and `npm test` are green. Every metrics-bearing `/chat` reply carries `promptTokens` and a `contextBreakdown` whose parts add up to `total` (SC-001).

---

## Phase 5: User Story 3 - The long-conversation script shows the context growing turn by turn (Priority: P3)

**Goal**: `scripts/long-conversation.sh` sends a fixed series of messages in one conversation and prints one line per turn, with the real `promptTokens` (or `n/a`) and the history estimate. It shows where the history levels off at 12 messages.

**Independent Test**: Against a test server with a fake strategy, `TURNS=3` prints exactly 3 `turn N | promptTokens … | history … (k messages)` lines with k = 0, 2, 4.

### Tests and implementation for User Story 3

- [X] T036 [US3] Extract the HTTP test helpers from `src/http/server.test.ts` into a new `src/testing/test-server.ts`, so the script test reuses them instead of copying them. Move:
  - `startServer(settings)`: it starts `createApp(settings)` on port 0 and returns the base URL. Its server tracking and `after` cleanup become `startServer` plus an exported `closeServers()` that each test file calls in its own `after`.
  - `FakeStrategy` and `fakeStrategy(name, result)`.
  - `completed(answer)`.
  - `settingsFor(strategies, extra)`.
  - `postChat(baseUrl, body)`.

  Make `src/http/server.test.ts` import them, with no behaviour change: every existing test still passes unchanged. The helpers use only fake stores and `ScriptedChatModel`, never `data/` or `OPSPILOT_DB`.
- [X] T037 [US3] Write `src/long-conversation.test.ts` per [contracts/long-conversation-script.md](contracts/long-conversation-script.md).
  - Skip the whole file, not fail it, when `command -v jq` or `command -v bash` fails.
  - Start the app with `startServer`, `settingsFor`, and `fakeStrategy` from `src/testing/test-server.ts` (T036): fake strategies, `FakeConversationStore`, fake memory store and embedder, no `data/` and no `OPSPILOT_DB`.
  - Run `bash scripts/long-conversation.sh` through `execFile` with `env: { ...process.env, OPSPILOT_URL, TURNS }`. Cases:
    - `TURNS=3` with a fake `react` strategy returning `promptTokens: 1000` prints exactly the 3 lines `turn 1 | promptTokens 1000 | history 0 (0 messages)`, then `turn 2 | … (2 messages)`, then `turn 3 | … (4 messages)`. The fake store holds one conversation, so every turn after the first reused the `conversationId` (US3-AS1).
    - A fake strategy returning `promptTokens: null` prints `promptTokens n/a` (US3-AS3).
    - A fake strategy that returns a `run_failed` error result on turn 2 only prints `turn 2 | error run_failed`, and turn 3 still prints a metrics line (US3-AS2, 502).
    - A fake strategy that hangs on turn 2 only (a promise that resolves after the test ends, or never), with `settingsFor(..., { timeoutMs: 50 })`, prints `turn 2 | error timeout`, and turn 3 still prints a metrics line (US3-AS2, 504).
    - `OPSPILOT_URL` pointing at a closed port gives exit code 1 and stderr containing `Cannot reach http://127.0.0.1:<port>` (US3-AS4).
    - A trailing `/` on `OPSPILOT_URL` still works.
    - `TURNS=0` and `TURNS=abc` give exit code 2 and stderr `TURNS must be a positive integer`.
    - Default `TURNS` (unset) prints 10 lines.
  - Close the server in `after`.
- [X] T038 [US3] Write `scripts/long-conversation.sh` (with a `#!/usr/bin/env bash` shebang, `set -u`, mode `chmod +x`) per [contracts/long-conversation-script.md](contracts/long-conversation-script.md):
  - **Environment**:
    - `OPSPILOT_URL` defaults to `http://127.0.0.1:3000`, with a trailing `/` stripped.
    - `TURNS` defaults to `10` and must match `^[1-9][0-9]*$`. Otherwise print `TURNS must be a positive integer` to stderr and exit 2.
    - A missing `curl` or `jq` prints `<tool> is required` to stderr and exits 2.
  - **Messages**: a fixed array of 12 English on-call messages, for example "Which alerts are firing right now?" and "I am on the payments team.". Turn `n` sends `MESSAGES[(n - 1) % 12]`.
  - **Request body**:
    - Build it with `jq -n` as `{ message, strategy: "react", reflect: false }`.
    - Add `conversationId` once the first reply carrying one has arrived.
    - Never send a `userId`.
  - **Transport**:
    - Send each turn with `curl -sS --max-time 300 -H 'content-type: application/json'`, capturing the body and the `%{http_code}`.
    - Any curl failure prints `Cannot reach <OPSPILOT_URL>` to stderr and exits 1.
  - **Output**:
    - A 200 prints `turn <n> | promptTokens <metrics.promptTokens or n/a> | history <metrics.contextBreakdown.history> (<metrics.historyMessages> messages)`.
    - Any other status prints `turn <n> | error <body.error // "http_<status>">` and continues.
    - Exit 0 after all turns.
- [X] T039 [US3] Run `node --import tsx --test src/long-conversation.test.ts` and confirm all cases pass. Confirm `git ls-files --stage scripts/long-conversation.sh` (after staging) or `ls -l` shows the file as executable.

**Checkpoint**: All three stories work. `npm run typecheck` and `npm test` are green, and the script test runs on this machine (jq 1.7.1 is present).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T040 [P] Update `README.md`:
  - Add a Features table row for context measurement.
  - Add a short "Context measurement" section that covers:
    - `metrics.promptTokens` is real, summed over every model call of the run, and `null` when not reported.
    - `metrics.contextBreakdown` holds estimates (characters / 4, rounded up) of the starting context, with `total` equal to their sum.
    - The two are comparable only on `llmCalls: 1` runs.
    - How to run `scripts/long-conversation.sh` (`OPSPILOT_URL`, `TURNS`; needs `curl` and `jq`).
- [X] T041 Final verification from the repository root:
  - `npm run typecheck` and `npm test` are green.
  - `git diff --stat` shows no change to the MCP server, `formatMetrics` output, or bench rows.
  - `grep -rn "data/\|OPSPILOT_DB" src/**/*.test.ts` finds no new test touching the real database.
  - No test calls the real provider.
- [ ] T042 Manual quickstart (the user runs it with their own OpenRouter key; the agent never reads `.env`): run [quickstart.md](quickstart.md) §2–§5.
  - Real `promptTokens` is a positive integer or `null`.
  - The breakdown grows with history and memories.
  - The script's `(k messages)` count reaches 12 at turn 7 and stays there (SC-003).
  - The `contextBreakdown.total` versus `promptTokens` gap is within 30% on `llmCalls: 1` replies (SC-002).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. Blocks all stories (`tokens.ts` is used by US1's counter and US2's breakdown).
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after Foundational. In practice it follows US1, because both edit `src/domain/types.ts`, `src/http/schemas.ts`, `src/http/chat-reply.ts`, `src/http/server.test.ts`, and the strategy files. Run US1 first to avoid conflicting edits.
- **US3 (Phase 5)**: after US1 and US2, because the script prints `metrics.promptTokens` (US1) and `metrics.contextBreakdown.history` (US2).
- **Polish (Phase 6)**: after all stories.

### Within each story

- Tests first (see them fail), then implementation.
- US1:
  - T004 → T005 (scripted model).
  - T006 → T007 (counter).
  - T008 (type) before T009–T015.
  - T009–T011 before T012–T014.
  - T015 closes typecheck.
  - T016 → T017 → T018, T019.
- US2:
  - T020 → T021.
  - T022 before T023–T028.
  - T023 → T025 and T024 → T026.
  - T027 → T028.
  - T029 → T030.
  - T031 → T032.
  - T033 → T034, which needs T021, T025, T026, T028, and T032.
  - T035 last.
- US3: T036 → T037 → T038 → T039.

### Parallel Opportunities

- Foundational: T002 alone (then T003).
- US1: T004 ∥ T006 (different files). T009 ∥ T010 ∥ T011 (three test files). T016 ∥ T018 after T017.
- US2: T020 ∥ T023 ∥ T024 ∥ T027 (four test files). T025 ∥ T026 (two source files). T029 ∥ T031 ∥ T033 (three test files).
- Polish: T040 while T041 runs.

---

## Parallel Example: User Story 1

```text
# Red phase, three test files at once (after T008):
Task: "T009 react promptTokens sums in src/agents/react.test.ts"
Task: "T010 plan-execute promptTokens sums in src/agents/plan-and-execute.test.ts"
Task: "T011 reflection promptTokens sums in src/agents/reflection.test.ts"
```

## Parallel Example: User Story 2

```text
# Red phase:
Task: "T020 contextBreakdown and toolDefinitionsText in src/context/breakdown.test.ts"
Task: "T023 historyBlock round-trip in src/agents/history.test.ts"
Task: "T024 memoryBlock round-trip in src/agents/memories.test.ts"
# Green phase:
Task: "T025 historyBlock in src/agents/history.ts"
Task: "T026 memoryBlock in src/agents/memories.ts"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 and Phase 2 (`tokens.ts`).
2. Phase 3: real `promptTokens` on every run and every metrics-bearing `/chat` reply.
3. **Stop and validate**: `npm test` green, and one manual `/chat` call shows `promptTokens`.

### Incremental delivery

1. US1: real cost per reply (ground truth).
2. US2: the per-source breakdown explains the cost. The schema now requires `contextBreakdown`.
3. US3: the script turns both into the turn-by-turn lesson.
4. Polish: README, final checks, and the manual quickstart.

### Notes

- `promptTokens` sums every call, while the breakdown describes one starting context. Do not try to make them match on multi-call runs.
- plan-execute's breakdown over-counts its first call (research R4, known approximation). Leave it.
- Keep each commit to one story where possible, but commit only when the user asks.
