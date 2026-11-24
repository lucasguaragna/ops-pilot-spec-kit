# Research: Context Measurement

All Technical Context items were resolved from the code and from the installed `@langchain/core`
(1.3.x). No NEEDS CLARIFICATION remains.

## R1. Where the real input token count comes from

- **Decision**: Read `usage_metadata.input_tokens` from each chat generation's message in the
  `handleLLMEnd(output: LLMResult)` callback, and sum it per run.
- **Rationale**: `usage_metadata` (`{ input_tokens, output_tokens, total_tokens }`) is LangChain's
  provider-neutral usage field on `AIMessage` and `AIMessageChunk` (LangChain JS docs, "Messages >
  usage_metadata"; OpenRouter integration page). `ChatOpenAI`, which the project uses against
  OpenRouter, fills it on `invoke` and, with its default `streamUsage`, on the final streamed chunk.
  `handleLLMEnd` fires once per finished model call, including the forced-tool structured calls
  (planner, replanner, critic, learning step) because `withStructuredOutput(..., { includeRaw:
  true })` still runs the bound chat model. The callback already reaches every call of a run: the
  existing `LlmCallCounter` is passed in `callbacks` by each strategy and counts in
  `handleChatModelStart`.
- **Alternatives considered**:
  - `output.llmOutput.tokenUsage.promptTokens`: OpenAI-specific; not set by every integration.
    Rejected in favour of the standard field.
  - Reading `usage_metadata` from the final message list in the trace: misses structured calls
    (their raw message never reaches the agent state) and the retries in `requireToolUse` and
    `structured()`. Rejected.
  - `getNumTokens` or a tokenizer package: that is an estimate, not the billed number, and a new
    dependency. Rejected; the estimate is `estimateTokens` (R3).

## R2. How the counter holds the sum

- **Decision**: Extend the existing `LlmCallCounter` (`src/agents/llm-counter.ts`) with
  `promptTokens: number | null` (starts `null`) and a `handleLLMEnd` that adds the call's tokens
  through the pure `addPromptTokens`. The class keeps its name and `awaitHandlers = true`, so the
  sum is final when the run returns, like `count`.
- **Rationale**: Every strategy already creates one counter per run and passes it in `callbacks`.
  One handler, one place; no new wiring in react, plan-execute, or reflection beyond reading the
  field. `null` means "no call reported usage" (FR-003); a call that reports none adds nothing, so
  partial reporting sums the reported calls (spec edge case).
- **Alternatives considered**: a second callback class `UsageCounter`. Rejected: two handlers that
  must always be passed together.

## R3. The estimate rule

- **Decision**: `estimateTokens(text) = Math.ceil(text.length / 4)`; 0 for `""`.
- **Rationale**: FR-001 and the spec's teaching baseline. `String.prototype.length` counts UTF-16
  code units, so an emoji counts 2 and an accented letter 1; this is documented as an
  approximation, as the spec asks. Linear and total over any string, so it never throws.
- **Alternatives considered**: counting code points (`[...text].length`). Rejected: the spec fixes
  "the language's string length".

## R4. What each breakdown source measures

- **Decision**: The breakdown is built by a pure `contextBreakdown(texts)` over five strings, each
  the exact text the agent receives for that source:
  - `system`: the strategy's first-call system instructions, exposed as a new optional
    `ReasoningStrategy.systemPrompt` (react: `SYSTEM_PROMPT`; plan-execute: the planner prompt with
    its tool list filled in; reflection and the history and memory wrappers pass the base value
    through). A strategy without it measures 0.
  - `tools`: `JSON.stringify(tools.map(convertToOpenAITool))`, the provider-facing definitions
    (name, description, JSON Schema of the arguments) that `bindTools` sends. `convertToOpenAITool`
    is exported by `@langchain/core/utils/function_calling`. This includes the memory tools when
    the request has a `userId`.
  - `history`: the new pure `historyBlock(history)`, everything `composeInput` adds around the
    message (`"Conversation so far (oldest first):\n…\n\nCurrent request: "`), `""` for no history.
  - `memories`: the new pure `memoryBlock(memories)`, everything `composeMemoryInput` adds
    (`"Facts remembered about this engineer …:\n- [memory …] …\n\n"`), `""` for no memories.
  - `message`: the request's message.
  - `total`: the sum of the five estimates (not the estimate of the concatenation, so the parts
    always add up, FR-005).
- **Rationale**: `composeInput` and `composeMemoryInput` are refactored to `historyBlock(h) +
  message` and `memoryBlock(m) + input`. Their output does not change (an empty block is `""`), so
  the strategy input string is exactly `memoryBlock + historyBlock + message`, and the breakdown
  measures what the agent really gets (spec assumption: after the 12-message and 3-memory limits).
  The texts are built in `runChat`, which already holds the strategy, the tools, the history, the
  recalled memories, and the message.
- **Alternatives considered**:
  - Estimating the raw stored messages without the labels: the labels are real context. Rejected.
  - A per-strategy prompt table in `agents/index.ts`: duplicates the prompts and misses
    plan-execute's tool list. Rejected.
  - Counting tool observations: the spec scopes the breakdown to the starting context. Rejected.
- **Known approximation**: plan-execute's first call (the planner) lists tool names and
  descriptions in its prompt and binds only the `plan` tool; the full definitions reach the
  executor. Its breakdown therefore over-counts the first call. Documented, not fixed: the spec
  compares estimate and real count on single-call runs (SC-002).

## R5. Where the breakdown travels

- **Decision**: `runChat` adds `context: ContextBreakdown` to `ChatOutcome`, next to
  `recalledMemories`. `chat-reply.ts`'s `contextMetrics` adds `contextBreakdown` to every metrics
  object it builds (200 and the `run_failed` 502 with partial metrics). `promptTokens` comes from
  the domain `Metrics` through the existing spread.
- **Rationale**: Same path as `historyMessages` and `recalledMemories` (HTTP-only context
  counts). The breakdown is about the request's context, not the strategy run, so it does not
  belong in domain `Metrics`; `promptTokens` does, because the strategies produce it and the arena
  and bench get it for free.
- **Alternatives considered**: putting `contextBreakdown` in domain `Metrics`. Rejected: the
  strategies do not know the history or memory blocks.

## R6. Domain `Metrics` change

- **Decision**: `Metrics` gains a required `promptTokens: number | null`. React, plan-execute,
  and reflection set it from their counter; reflection adds each attempt's value with
  `addPromptTokens`, and the rewrite attempt carries `null` (its call is in reflection's own
  counter, the same rule as `llmCalls: 0`).
- **Rationale**: Required makes the compiler find every place that builds metrics (about 30 test
  literals, mechanical). `formatMetrics` (arena) and the bench rows stay as they are (FR-009, scope).
- **Alternatives considered**: optional `promptTokens?`. Rejected: a strategy could silently
  forget it.

## R7. The long-conversation script

- **Decision**: `scripts/long-conversation.sh` (bash, `curl`, `jq`), configured by environment:
  `OPSPILOT_URL` (default `http://127.0.0.1:3000`, the dev server's host and default port) and
  `TURNS` (default 10, a positive integer). It cycles through a fixed list of 12 on-call messages,
  sends turn 1 without `conversationId` and every later turn with the id from the first reply that
  carried one (200, 502, and 504 bodies all carry it), and prints one line per turn:
  `turn 3 | promptTokens 1834 | history 412 (4 messages)` or `turn 3 | error run_failed`.
  `promptTokens: null` prints `n/a`. A transport failure (curl cannot connect) prints
  `Cannot reach <url>` to stderr and exits 1.
- **Rationale**: Spec assumption (shell script, English name, `curl` and `jq`). Showing
  `historyMessages` next to the estimate makes the turn where the history stops growing obvious
  (SC-003): it climbs 0, 2, 4 … and stays at 12.
- **Testing**: `src/long-conversation.test.ts` starts the app on port 0 with fake strategies whose
  metrics carry known `promptTokens`, runs the script with `execFile("bash", …)` and a small
  `TURNS`, and checks the printed lines, `n/a`, an error line, and the unreachable exit. It is
  skipped when `jq` or `bash` is missing, so the suite stays green on a machine without them.
- **Alternatives considered**: a TypeScript script under `src/` run by `npm run`. Simpler to unit
  test, but the spec fixes a shell script. Rejected.

## R8. Tests use a fake model only

- **Decision**: `ScriptedChatModel` copies a scripted turn's `usage_metadata` onto the chunk it
  returns; a helper `withUsage(turn, inputTokens)` builds such a turn. Tests of react,
  plan-execute, and reflection script usage per call and check the sums; one turn without usage
  checks the `null` and partial cases.
- **Rationale**: FR-012; no provider call in tests. Copying `usage_metadata` keeps the fake as
  close as possible to `ChatOpenAI`, so `handleLLMEnd` sees the same shape.
