# Contract: `POST /chat` changes

## Request

```json
{ "message": "Open an incident for each critical alert, then summarize" }
```

| Field | Change |
| --- | --- |
| `strategy` | Optional, no default. `"react"`, `"plan-execute"`, or `"reflect"` forces that route (override). Absent: the router decides. |
| `reflect` | Optional, default `false`. `true` is the same as `strategy: "reflect"`. |
| `message`, `conversationId`, `userId` | Unchanged. |

Validation order, unchanged apart from the new rule:

1. Body shape (zod). New: `reflect: true` with `strategy` set to anything other than `"reflect"` is
   a `400 invalid_body`, with an issue at `["reflect"]` whose message is
   `"reflect: true only combines with strategy \"reflect\""`.
2. Unknown `strategy`: `422 unknown_strategy` with
   `knownStrategies: ["react", "plan-execute", "reflect"]`. Nothing is read or written.
3. Unknown `conversationId`: `404 conversation_not_found`.
4. Recall failure: `500 internal`.

| Body | Result |
| --- | --- |
| `{ message }` | The router decides |
| `{ message, strategy: "plan-execute" }` | plan-execute, `source: "override"` |
| `{ message, reflect: true }` | reflect, `source: "override"` |
| `{ message, strategy: "reflect", reflect: true }` | reflect, `source: "override"` |
| `{ message, strategy: "react", reflect: false }` | react, `source: "override"` |
| `{ message, strategy: "react", reflect: true }` | `400 invalid_body` |
| `{ message, strategy: "nope" }` | `422 unknown_strategy` |

## 200: a router choice, after a summarization

```json
{
  "conversationId": "5b0c…",
  "answer": "Opened INC-007 and INC-008 for the two critical alerts.",
  "stopReason": "completed",
  "trace": [
    { "node": "context", "type": "summarize", "absorbed": 8, "content": "Summary of the earlier conversation …" },
    { "node": "router", "type": "route", "route": "plan-execute", "source": "router",
      "reason": "Several alerts, one action each, then a summary: an ordered plan fits." },
    { "node": "plan-execute", "type": "plan", "steps": ["List critical firing alerts", "Open an incident for each", "Summarize"] },
    { "node": "plan-execute", "type": "action", "tool": "list_alerts", "args": { "status": "firing" } },
    { "node": "plan-execute", "type": "observation", "tool": "list_alerts", "content": "[…]" },
    { "node": "response", "type": "answer", "content": "Opened INC-007 and INC-008 for the two critical alerts." }
  ],
  "metrics": {
    "llmCalls": 7,
    "latencyMs": 9120,
    "historyMessages": 8,
    "recalledMemories": 0,
    "promptTokens": 8840,
    "contextBreakdown": { "system": 0, "tools": 640, "history": 260, "memories": 0, "message": 14, "total": 914 }
  }
}
```

`llmCalls` here is 1 (summarizer) + 1 (router) + 5 (plan-and-execute).

## The `route` event

```json
{ "node": "router", "type": "route", "route": "react", "source": "fallback", "reason": "Router failed: invalid answer" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `node` | `"router"` | Always |
| `route` | `"react" \| "plan-execute" \| "reflect"` | The route that ran |
| `source` | `"router" \| "override" \| "fallback"` | Who decided |
| `reason` | `string` | The router's text; `"Requested by the caller"` for an override; `"Router failed: …"` for a fallback |

Exactly one `route` event per reply that has a trace. It comes after any `summarize` event and
before every strategy event.

## `node` on every event

Every event in `trace`, in `200` replies and in `502 run_failed` replies that carry a trace, has
`node`, one of: `"context"`, `"router"`, `"react"`, `"plan-execute"`, `"reflect"`, `"response"`. The
existing event fields are unchanged.

- A run stopped by the iteration limit has no `response` event, and its last event belongs to the
  strategy node.
- In a `reflect` run, rejected drafts keep `node: "reflect"`. Only the approved final answer has
  `node: "response"`.

## Unchanged

`timeout` (now covering context, router, and strategy), `run_failed` without a trace (a thrown
run), `conversation_not_found`, `internal`, and every metrics field.
