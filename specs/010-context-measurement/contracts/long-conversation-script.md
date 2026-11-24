# Contract: `scripts/long-conversation.sh`

## Invocation

```sh
scripts/long-conversation.sh
OPSPILOT_URL=http://127.0.0.1:3001 TURNS=14 scripts/long-conversation.sh
```

| Variable | Default | Rule |
| --- | --- | --- |
| `OPSPILOT_URL` | `http://127.0.0.1:3000` | Base URL; the script posts to `$OPSPILOT_URL/chat`. A trailing `/` is dropped. |
| `TURNS` | `10` | Positive integer. Anything else prints `TURNS must be a positive integer` to stderr and exits 2. |

Requires `bash`, `curl`, and `jq`. A missing `curl` or `jq` prints `<tool> is required` and
exits 2.

## Requests

Turn `n` sends `{ "message": MESSAGES[(n - 1) % 12], "strategy": "react", "reflect": false }`.
From the first reply that carries a `conversationId` onward, every later turn adds that
`conversationId`. No `userId`, so the learning step never runs and memories stay 0. The 12
messages are fixed English on-call questions and statements, such as "Which alerts are firing
right now?" and "I am on the payments team.".

## Output (stdout)

One line per turn, in order:

```text
turn 1 | promptTokens 1410 | history 0 (0 messages)
turn 2 | promptTokens 1622 | history 61 (2 messages)
turn 3 | error run_failed
turn 4 | promptTokens n/a | history 97 (4 messages)
```

- A 200 prints `promptTokens` (`n/a` for `null`), `metrics.contextBreakdown.history`, and
  `metrics.historyMessages`.
- Any other status prints `error <body.error>`, or `error http_<status>` when the body has no
  `error` field. The script then continues with the next turn.

## Exit status

| Case | Status | stderr |
| --- | --- | --- |
| All turns sent (even if some failed) | 0 | nothing |
| curl cannot connect or the connection drops | 1 | `Cannot reach <OPSPILOT_URL>` |
| Bad `TURNS` or a missing tool | 2 | the reason |

Each request has a `curl --max-time` of 300 s, longer than the server's own run timeout, so the
server's 504 is what the script sees.
