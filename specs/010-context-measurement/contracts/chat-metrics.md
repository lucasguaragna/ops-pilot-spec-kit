# Contract: `/chat` reply metrics

The request body is unchanged. Only the `metrics` object changes, and only where metrics already
appear: the 200 reply and the `run_failed` 502 that carries partial metrics.

## 200

```json
{
  "conversationId": "5b0c…",
  "answer": "Two alerts are firing on checkout.",
  "stopReason": "completed",
  "trace": [],
  "metrics": {
    "llmCalls": 2,
    "latencyMs": 1830,
    "historyMessages": 4,
    "recalledMemories": 1,
    "promptTokens": 2710,
    "contextBreakdown": {
      "system": 112,
      "tools": 640,
      "history": 180,
      "memories": 31,
      "message": 9,
      "total": 972
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `promptTokens` | Real input tokens the provider reported, summed over every model call of the run: planner, ReAct steps, retries, critic, rewrite. `null` when no call reported usage. The learning step (009) is not included. |
| `contextBreakdown.*` | Estimates (characters / 4, rounded up) of the starting context per source. `total` is their sum. |

`promptTokens` covers every call of the run and `contextBreakdown` describes one context, so
compare the two only on single-call runs (`llmCalls: 1`).

## 502 `run_failed`

When the strategy returned an error result (partial trace and metrics), `metrics` has the same
six fields, with `promptTokens` covering the calls made before the failure. A 502 from a thrown
run carries no `metrics`, as before.

## 504 `timeout`, 400, 404, 422, 500

Unchanged: no metrics.

## Schema

```ts
const ContextBreakdownSchema = z
  .object({ system: Count, tools: Count, history: Count, memories: Count, message: Count, total: Count })
  .refine((b) => b.total === b.system + b.tools + b.history + b.memories + b.message, {
    message: "total must equal the sum of the sources",
    path: ["total"],
  });

export const MetricsSchema = z.object({
  llmCalls: Count,
  latencyMs: Count,
  historyMessages: Count,
  recalledMemories: Count,
  promptTokens: Count.nullable(),
  contextBreakdown: ContextBreakdownSchema,
});
```
