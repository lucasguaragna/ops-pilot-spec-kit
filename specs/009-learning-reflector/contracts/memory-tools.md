# Contract: Memory tools changes

Extends [008 memory-tools](../../008-semantic-memory/contracts/memory-tools.md). `remember_fact`
and `forget_fact` are unchanged. `createMemoryTools(memories, userId)` now returns three tools, in
this order: `remember_fact`, `forget_fact`, `forget_preference`. They are still offered only when
the request has a `userId`, and still not exposed by the MCP server.

## `forget_preference`

- **Defined in**: `forgetPreferenceDefinition`, `src/tools/memory-definitions.ts`.
- **Input**: `ForgetPreferenceInput` = `{ description: MemoryFact }`. No user id: the tool acts on
  the `userId` captured when it was built.
- **Description for the model** (draft): "Forget a saved fact by describing it, when the engineer
  asks you to forget something and you do not have its [memory N] id. Give a short description of
  the fact, for example 'prefers bullet lists'. Only the single closest saved fact is removed, and
  only if it matches closely. Returns { id, fact, forgotten: true } for the removed fact, or {
  forgotten: false } when no saved fact matches."
- **Output**: JSON `{ id, fact, forgotten: true }`, or `{ forgotten: false }`.
- **Runs through**: `runToolTextAsync`, like `remember_fact`.

## Errors

| Cause | What the model sees | Run |
| --- | --- | --- |
| No fact scores at least 0.5 | `{ "forgotten": false }` (not an error) | continues |
| Invalid input (blank or over 500 characters) | a tool error message | continues |
| `EmbeddingError` | nothing; the run fails | 502 `run_failed` |
