# Contract: `POST /chat` changes

Only the differences from `specs/007-persistent-conversation/contracts/chat-api.md`.

## Request

```json
{
  "message": "who should I page about failed purchases?",
  "strategy": "react",
  "reflect": false,
  "conversationId": "optional uuid",
  "userId": "optional, 1-128 characters after trimming"
}
```

- `userId` missing: no recall, no memory tools, `recalledMemories` is 0 (FR-013).
- `userId` empty, whitespace-only, over 128 characters, or not a string: 400 `invalid_body`.

## Reply 200

`metrics` gains `recalledMemories` (0 to 3):

```json
{
  "conversationId": "…",
  "answer": "…",
  "stopReason": "completed",
  "trace": [],
  "metrics": { "llmCalls": 2, "latencyMs": 1830, "historyMessages": 0, "recalledMemories": 1 }
}
```

## Errors

| Case | Status | Body |
| --- | --- | --- |
| 502 `run_failed` with partial metrics | 502 | `metrics.recalledMemories` added |
| Recall fails (`EmbeddingError`: model cannot load or embed) | 500 | `{ "error": "internal", … }`; the server logs `Memory recall failed: <message>`; no conversation is created |

Other replies are unchanged.

## Order of checks

400 (body) → 422 (strategy) → 404 (conversation) → recall (500 on failure) → create conversation →
run (502 / 504).
