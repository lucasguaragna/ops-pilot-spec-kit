# Contract: Memory tools

Defined in `src/tools/memory-definitions.ts`, built by `createMemoryTools(memories, userId)` in
`src/agents/memory-tools.ts`. Offered to the agent only when the chat request has a `userId`. Not
part of `TOOL_DEFINITIONS`, so the MCP server does not expose them. Neither schema has a user id:
the tools always act on the `userId` captured when they were built.

## `remember_fact`

- **Input**: `{ fact: MemoryFact }`
- **Description for the model** (draft): "Save a lasting fact about the engineer or their systems,
  for later conversations. Use when the engineer states something that will still be true later
  (who owns a service, a preference, a quirk of their setup), not for questions or for the state of
  a live alert. One fact per call, in one short sentence. Returns { id, fact, created }; created
  false means a nearly identical fact was already saved and nothing new was stored."
- **Output**: JSON `{ id, fact, created }`.

## `forget_fact`

- **Input**: `{ id: MemoryId }`
- **Description for the model** (draft): "Forget a saved fact. Use when the engineer says a fact is
  wrong or no longer true. The id is the N in [memory N] from the remembered facts at the top of
  the request. Returns { id, forgotten: true }. Returns 'Error: ...' when there is no such fact."
- **Output**: JSON `{ id, forgotten: true }`, or `Error: Memory not found: <id>`.

## Errors

| Cause | What the model sees | Run |
| --- | --- | --- |
| `MemoryNotFoundError` (domain) | `Error: Memory not found: <id>` | continues |
| Invalid input (schema) | a tool error message | continues |
| `EmbeddingError` | nothing; the run fails | 502 `run_failed` |
