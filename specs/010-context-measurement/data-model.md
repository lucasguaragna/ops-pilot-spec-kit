# Data Model: Context Measurement

No persisted data. Everything below is in memory or in the HTTP reply.

## Token estimate

An integer: `Math.ceil(text.length / 4)`. `""` is 0, a 1-character string is 1. `length` counts
UTF-16 code units, so it is an approximation (research R3).

## Metrics (domain, `src/domain/types.ts`)

| Field | Type | Rule |
| --- | --- | --- |
| `llmCalls` | integer ≥ 0 | unchanged |
| `latencyMs` | integer ≥ 0 | unchanged |
| `promptTokens` | integer ≥ 0 or `null` | **new**. Sum of `usage_metadata.input_tokens` over every model call of the run that finished and reported usage. `null` when none did. |

Summing rule (`addPromptTokens(total, more)`):

| `total` | `more` | result |
| --- | --- | --- |
| `null` | `null` / `undefined` | `null` |
| `null` | `n` | `n` |
| `t` | `null` / `undefined` | `t` |
| `t` | `n` | `t + n` |

A call reports usage only when its message has an `input_tokens` that is a non-negative integer.
Anything else counts as not reported. A call that fails or is aborted produces no `handleLLMEnd`,
so it adds nothing.

Reflection: `promptTokens = addPromptTokens(Σ attempts' promptTokens, own counter)`. The rewrite
attempt carries `null`, because its call is in reflection's own counter.

## ReasoningStrategy (domain)

Gains `systemPrompt?: string`, the system instructions of the strategy's first model call.

| Strategy | `systemPrompt` |
| --- | --- |
| `react` | `SYSTEM_PROMPT` |
| `plan-execute` (both variants) | the planner prompt with `{tools}` filled in |
| `reflect:*` | the base strategy's value |
| `withHistory` / `withMemories` wrappers | the wrapped strategy's value |
| any other (test fakes) | absent, measured as 0 |

## ContextTexts (`src/context/breakdown.ts`)

The five texts the agent starts a run with, all strings:

| Field | Built from (in `runChat`) |
| --- | --- |
| `system` | `strategy.systemPrompt ?? ""` |
| `tools` | `toolDefinitionsText(tools)` = `JSON.stringify(tools.map(convertToOpenAITool))`. The tools include the memory tools when the request has a `userId`. |
| `history` | `historyBlock(history)`: `""` for no history |
| `memories` | `memoryBlock(recalled)`: `""` for no memories |
| `message` | `request.message` |

Invariant: `composeMemoryInput(m, composeInput(h, msg)) === memoryBlock(m) + historyBlock(h) + msg`.
This is the exact input string the strategy receives.

## ContextBreakdown

| Field | Type | Rule |
| --- | --- | --- |
| `system` | integer ≥ 0 | `estimateTokens(texts.system)` |
| `tools` | integer ≥ 0 | `estimateTokens(texts.tools)` |
| `history` | integer ≥ 0 | `estimateTokens(texts.history)` |
| `memories` | integer ≥ 0 | `estimateTokens(texts.memories)` |
| `message` | integer ≥ 0 | `estimateTokens(texts.message)` |
| `total` | integer ≥ 0 | sum of the five above (not the estimate of their concatenation) |

Validation (`ContextBreakdownSchema`): each field is `Count`, and a refinement checks that
`total === system + tools + history + memories + message`.

## ChatOutcome (`src/http/chat-reply.ts`)

Gains `context: ContextBreakdown`. It is set by `runChat` for every outcome (result, thrown,
timeout), but only the replies that carry metrics expose it.

## HTTP metrics (`MetricsSchema`)

`llmCalls`, `latencyMs`, `historyMessages`, `recalledMemories` (unchanged), plus:

- `promptTokens`: `Count.nullable()`
- `contextBreakdown`: `ContextBreakdownSchema`

## TurnLine (script output)

One line per turn on stdout:

| Case | Line |
| --- | --- |
| 200 | `turn <n> \| promptTokens <int or n/a> \| history <int> (<k> messages)` |
| any other status (502 with or without partial metrics, 504, 404, …) | `turn <n> \| error <code>`, where `<code>` is the body's `error` field, or `http_<status>` when the body has none |

`<n>` starts at 1. `<k>` is `metrics.historyMessages`. A transport failure prints
`Cannot reach <url>` to stderr and the script exits 1.
