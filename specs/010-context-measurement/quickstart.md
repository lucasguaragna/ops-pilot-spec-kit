# Quickstart: Context Measurement

## Prerequisites

- Node.js 22.13 or newer, `npm install` done
- `bash`, `curl`, `jq` (for the script)
- For the manual scenarios: an OpenRouter key and model in `.env` (`OPENROUTER_API_KEY`,
  `OPENROUTER_MODEL`), which only the app reads

## 1. Automated checks

```sh
npm run typecheck
npm test
```

Expected: both green. The new tests cover:

- `estimateTokens`, `promptTokensOf`, and `addPromptTokens` (see
  [contracts/context-module.md](contracts/context-module.md))
- `contextBreakdown` (the spec example gives a total of 560)
- `historyBlock` and `memoryBlock` round-trips
- the counter's usage sum, including the `null` and partial cases
- per-strategy `promptTokens`: react, plan-execute, reflection
- the `/chat` 200 and 502 metrics (see [contracts/chat-metrics.md](contracts/chat-metrics.md))
- the script's output lines

The script test is skipped, not failed, when `jq` is missing.

## 2. Real usage on one reply (Story 1)

```sh
npm run dev
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?","reflect":false}' | jq .metrics
```

Expected:

- `promptTokens` is a positive integer, or `null` if the chosen model reports no usage.
- `contextBreakdown` has `history: 0` and `memories: 0`, with `total` equal to the sum of the five
  sources.
- `llmCalls` is the same as before this feature for the same request.

Repeat with `"reflect": true`. Expected: `promptTokens` grows by at least the critic call's input.

## 3. Sources grow (Story 2)

Send a second message with the `conversationId` from step 2, and a `userId` with saved facts.
Expected: `contextBreakdown.history > 0`, `historyMessages: 2`, and `memories > 0` when
`recalledMemories > 0`.

## 4. Long conversation (Story 3)

```sh
scripts/long-conversation.sh            # 10 turns against 127.0.0.1:3000
TURNS=14 scripts/long-conversation.sh   # past the 12-message limit
```

Expected:

- One `turn N | …` line per turn, all in the same conversation.
- The `(k messages)` count goes 0, 2, 4, … and stays at 12 from turn 7 on. That is the turn where
  the history stops growing (SC-003).
- A failed turn prints `error <code>`, and the next turn still runs.

Stop the server and run the script again. Expected: `Cannot reach http://127.0.0.1:3000` on
stderr and exit status 1 (`echo $?`).

## 5. Estimate versus real (SC-002, manual)

On any 200 reply with `llmCalls: 1`, compare `contextBreakdown.total` with `promptTokens`.
Expected: within 30%. Multi-call runs sum several contexts, so they are not comparable.

React usually makes at least 2 calls, one tool call and then the answer. The closest comparison
is therefore a ReAct turn's `promptTokens / llmCalls` against `total`. That average is somewhat
above the starting context, because the observations add to it.
