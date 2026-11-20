# Contract: `POST /chat` (changes only)

The request and reply bodies are validated by the zod schemas in `src/http/schemas.ts`. Fields not
listed here are unchanged.

## Request

```jsonc
{
  "message": "open an incident for the worst one",
  "strategy": "react",           // unchanged, default "react"
  "reflect": false,              // unchanged
  "conversationId": "3f0c…-uuid" // NEW, optional, must be a UUID
}
```

- A missing `conversationId` starts a new conversation.
- A `conversationId` that is not a UUID gives a 400 `invalid_body` with the issue path
  `["conversationId"]`.

## 200 reply

```jsonc
{
  "conversationId": "3f0c…-uuid",                              // NEW, always present
  "answer": "Opened INC-003 for ALT-001 …",
  "stopReason": "completed",
  "trace": [ … ],
  "metrics": { "llmCalls": 3, "latencyMs": 2100, "historyMessages": 2 } // historyMessages NEW
}
```

## 404 reply (new)

```json
{
  "error": "conversation_not_found",
  "message": "Conversation not found: 3f0c…-uuid",
  "conversationId": "3f0c…-uuid"
}
```

The agent does not run, and nothing is written.

## 502 `run_failed` and 504 `timeout`

Both gain `conversationId` (required). When a `run_failed` reply has `metrics`, the metrics gain
`historyMessages`. Nothing is saved to the conversation in either case.

## Unchanged

- 400 `invalid_body`, 422 `unknown_strategy` (checked before any conversation is created or read),
  and 500 `internal`.
