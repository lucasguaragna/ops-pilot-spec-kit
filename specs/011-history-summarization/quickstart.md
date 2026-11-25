# Quickstart: History Summarization

## Prerequisites

- Node.js 22.13 or newer, with `npm install` done.
- `curl` and `jq`, for the script.
- For the manual scenarios: an OpenRouter key and model in `.env`, which only the app reads.

## 1. Automated checks

```sh
npm run typecheck
npm test
```

Expected: both are green. The new tests cover:

- The store additions, run against `:memory:` and the fake, including a lost compare-and-swap and
  a restart on a temporary file ([contracts/conversation-store.md](contracts/conversation-store.md)).
- `planHistory`, `cleanSummary`, `fitSummary`, `renderSummary`, and `summaryMessages`
  ([contracts/history-summarizer.md](contracts/history-summarizer.md)).
- 20 exchanges through `runChat` with a scripted summarizer. It runs on exchanges 9, 13, and 17
  only, and each call gets the previous summary.
- The context order: memories, summary, verbatim, message.
- The `summarize` event and the metrics ([contracts/chat-reply.md](contracts/chat-reply.md)).
- The failure path: the reply is unchanged, the summary is unchanged, and one log line is written.

## 2. A long conversation (Stories 1 and 3)

```sh
npm run dev
TURNS=18 scripts/long-conversation.sh
```

Expected: the `(k messages)` count goes 0, 2, …, 14, then back to 8 on turn 9, then 10, 12, 14,
8 on turn 13, and so on.

The `history` estimate does not fall back to its first value, because the summary block stays in
it. On turns 9, 13, and 17, `promptTokens` includes the summarizer's call.

## 3. The summary survives a restart (Story 2)

1. Note the conversation id the script printed on turn 1, or send messages by hand.
2. Stop the server and start it again.
3. Send one more message in that conversation.

Expected: no `summarize` event, and `metrics.contextBreakdown.history` still includes the summary
(it is larger than the estimate of the verbatim messages alone).

To inspect the stored row without the app:

```sh
sqlite3 data/opspilot.db "SELECT covered_messages, summary FROM conversation_summaries WHERE conversation_id = '<id>'"
```

## 4. The event on the reply

Send the 9th message of a conversation with `curl … | jq '.trace[0]'`.

Expected: `{ "type": "summarize", "absorbed": 8, "content": "Summary of the earlier conversation …" }`.

The 10th message has no such event.

## 5. A failing summarizer (Story 3)

This is not reproducible by hand with a healthy provider. It is covered by the automated tests in
§1.
