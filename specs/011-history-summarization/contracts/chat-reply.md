# Contract: `/chat` reply changes

The request body is unchanged. Only the trace and the metrics change, and only on requests that
summarize or carry a summary.

## 200 on the request that summarized

```json
{
  "conversationId": "5b0c…",
  "answer": "INC-002 is still open; the rollback finished.",
  "stopReason": "completed",
  "trace": [
    {
      "type": "summarize",
      "absorbed": 8,
      "content": "Summary of the earlier conversation (oldest messages first, merged):\n- Decision: page payments team for checkout alerts\n- checkout-api runs on eu-west cluster\n- Open: INC-002 stays open until deploy finishes\n\n"
    },
    { "type": "action", "tool": "list_incidents", "args": { "status": "open" } }
  ],
  "metrics": {
    "llmCalls": 3,
    "latencyMs": 4120,
    "historyMessages": 8,
    "recalledMemories": 0,
    "promptTokens": 3920,
    "contextBreakdown": { "system": 112, "tools": 640, "history": 260, "memories": 0, "message": 9, "total": 1021 }
  }
}
```

| Field | Change |
| --- | --- |
| `trace[0]` | `summarize` only on the request whose summarization stored a new summary. Never on any other request. |
| `metrics.llmCalls`, `metrics.promptTokens` | Include the summarization's calls, both when it stored and when it failed. |
| `metrics.historyMessages` | Messages given word for word: 0 to 14. |
| `metrics.contextBreakdown.history` | The estimate of the summary block plus the verbatim block. |

## Schema

```ts
z.object({ type: z.literal("summarize"), content: z.string(), absorbed: Count.min(1) })
```

It is added to `TraceEventSchema`, so it is accepted in `ChatReply.trace` and in the
`run_failed` 502 `trace`.

## Unchanged

- 400, 404, 422, 500, and 504 bodies.
- A failed summarization never changes the status code (FR-010).

## Server log lines

See research R9. They name the conversation id and counts, and never the summary's text.
