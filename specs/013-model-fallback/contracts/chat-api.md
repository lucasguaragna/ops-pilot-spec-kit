# Contract: `POST /chat` changes

The request is unchanged. Every reply that carries metrics gains `modelUsed`, and traces may hold
`fallback` events. A new `503` reply exists.

## `fallback` trace event

```json
{ "node": "react", "type": "fallback", "from": "primary/model:free", "to": "backup/model:free", "error": "RateLimitError" }
```

| Field | Rule |
| --- | --- |
| `node` | Any node that makes model calls: `context`, `router`, `react`, `plan-execute`, `reflect` |
| `from`, `to` | Non-empty model names from the settings |
| `error` | Non-empty class name; never provider text (FR-008) |

Zod: a new `z.object({ node, type: z.literal("fallback"), from, to, error })` branch of
`TraceEventSchema` (FR-014).

## `metrics.modelUsed`

`z.string().min(1).nullable()` in `MetricsSchema`. Present on `200`, `502 run_failed` (when it has
metrics), and `503 model_unavailable` (when it has metrics).

## 200: the primary failed once, the fallback answered

```json
{
  "conversationId": "5b0c…",
  "answer": "There are 2 critical alerts: …",
  "stopReason": "completed",
  "trace": [
    { "node": "router", "type": "route", "route": "react", "reason": "…", "source": "router" },
    { "node": "react", "type": "fallback", "from": "primary/model:free", "to": "backup/model:free", "error": "RateLimitError" },
    { "node": "react", "type": "action", "tool": "list_alerts", "args": {} },
    { "node": "react", "type": "observation", "tool": "list_alerts", "content": "…" },
    { "node": "response", "type": "answer", "content": "There are 2 critical alerts: …" }
  ],
  "metrics": {
    "llmCalls": 6,
    "latencyMs": 9120,
    "promptTokens": 4210,
    "modelUsed": "primary/model:free",
    "historyMessages": 0,
    "recalledMemories": 0,
    "contextBreakdown": { "system": 300, "tools": 210, "history": 0, "memories": 0, "message": 12, "total": 522 }
  }
}
```

Here the router answered on the primary model (1 call). ReAct's first call failed 3 times on the
primary and then went to the fallback (4 calls). Its second call answered on the primary again
(1 call, so `modelUsed` is the primary), because the switch applies to one call only (FR-006).

## 503: no model could answer

```json
{
  "error": "model_unavailable",
  "message": "No model could answer; try again later",
  "runError": { "name": "RateLimitError", "message": "The run failed; details are in the server log" },
  "conversationId": "5b0c…",
  "trace": [
    { "node": "router", "type": "fallback", "from": "primary/model:free", "to": "backup/model:free", "error": "RateLimitError" },
    { "node": "router", "type": "route", "route": "react", "reason": "…", "source": "fallback" },
    { "node": "react", "type": "fallback", "from": "primary/model:free", "to": "backup/model:free", "error": "RateLimitError" }
  ],
  "metrics": { "llmCalls": 8, "modelUsed": null, "...": "same fields as the 200" }
}
```

Zod: a new `ErrorReply` branch shaped like `run_failed`, with
`error: z.literal("model_unavailable")`. `runError.name` is the class name of the primary model's
final error (FR-011, research R7). There is no `Retry-After` header. The server log line names
`ModelUnavailableError` and its cause, and never the API key (FR-013).

## Status mapping

| Outcome | Status |
| --- | --- |
| Run completed or hit the iteration limit | 200 (unchanged) |
| Run error named `ModelUnavailableError` (`result` or `thrown`) | **503 `model_unavailable`** |
| Any other run error | 502 `run_failed` (unchanged) |
| Request timeout, including an abort during a retry or the fallback | 504 `timeout` (unchanged) |
