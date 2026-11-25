# Research: Model Fallback

All findings were checked against the installed sources: `@langchain/core` 1.3.2
(`dist/runnables/base.js`, `dist/language_models/chat_models.js`), `@langchain/openai` 1.8.0, and
`langchain` 1.6.0 (`dist/agents/nodes/AgentNode.js`, `dist/agents/utils.js`). The course reference
is `docs/code-examples/spec13-example.ts`.

## R1. Where `withRetry` and `withFallbacks` go

**Decision**: `createModel` returns a `ResilientChatModel`, a small `BaseChatModel` subclass in
`src/agents/resilient-model.ts`. It holds the primary and the optional fallback `ChatOpenAI` and
builds one composition per call shape:

```text
shape(primary).withRetry({ stopAfterAttempt, onFailedAttempt: retryFailedCall })
  .withFallbacks([shape(fallback)])          // only when a fallback is set
  -> translate the final error               // ModelUnavailableError, see R7
```

`shape` is the identity for `invoke`, `m => m.bindTools(tools, kwargs)` for `bindTools`, and
`m => m.withStructuredOutput(schema, config)` for `withStructuredOutput`. `invoke` is overridden to
run the identity composition directly, so the wrapper itself opens no chat model run.

**Rationale**: every consumer takes a `BaseChatModel` and calls `bindTools` (createAgent, through
`_simpleBindTools`), `withStructuredOutput` (router, planner, replanner, critic, learning
reflector), or `invoke` (summarizer, reflection rewrite). `withRetry` returns a `RunnableRetry` and
`withFallbacks` a `RunnableWithFallbacks`; neither has `bindTools` nor `withStructuredOutput`, so
returning them from the factory, as the reference does, breaks the router and createAgent. Binding
tools and the output schema on each `ChatOpenAI` before composing keeps ChatOpenAI's own behaviour,
including the forced `tool_choice` of `method: "functionCalling"` that the steps rely on.

**Alternatives considered**:

- Return `primary.withRetry().withFallbacks([backup])` as the reference does: breaks every caller
  that binds tools or a schema.
- Inherit `BaseChatModel.withStructuredOutput` and implement only `bindTools`: the base version
  binds the schema as a tool but does not force `tool_choice`, so a model may answer in plain text.
- LangChain's agent middleware for retries and model fallback: covers only `createAgent`, not the
  router, plan-execute, reflection, or summarizer calls.
- A hand-written `_generate` with try/catch: re-implements `withFallbacks`, and the inner models'
  callbacks stop firing, so the counter loses the per-model view that R5 needs.

## R2. Retry placement and bounds

**Decision** (revised at implementation, following `docs/code-examples/spec13-example.ts`): both
`ChatOpenAI` instances get `maxRetries: 0`. The retry lives only in `withRetry`, on the primary and
on the fallback, with `stopAfterAttempt: 2` (`MODEL_ATTEMPTS`) and the existing `retryFailedCall` as
`onFailedAttempt`.

**Rationale**: ChatOpenAI retries internally through its `AsyncCaller` (default `maxRetries` 6,
with `onFailedAttempt` today). Keeping it would stack two retry loops. `RunnableRetry` runs
`p-retry` and calls `onFailedAttempt(error, input)`; a throw there stops the retries, which is the
contract `retryFailedCall` already follows, so the rule of which errors retry is unchanged
(FR-003). `p-retry` defaults (1 s first wait, factor 2, randomized) give at most about 6 s of
waiting for 2 attempts per model, well inside the 180 s request timeout. Two attempts per model is
what the course reference uses.

**Alternatives considered**: keep the internal `maxRetries` and skip `withRetry` (retries would not
show in callbacks, but the input asks for `withRetry` explicitly); 3 attempts on the primary only
(the first plan; replaced by the reference's shape).

## R3. The fallback is retried too

**Decision** (revised at implementation): the fallback is wrapped in the same `withRetry` as the
primary, as the course reference does. The first plan gave it one attempt; the reference was chosen
instead. The worst case is 2 attempts on each model, about 2 s of backoff each, still far inside the
180 s request timeout.

**Rationale**: a fallback that fails once on a busy free model would otherwise fail the call. The
counter treats the fallback's retries as one switch (they start more fallback runs, but follow
the same primary failure).

## R4. Cancellation

**Decision**: no extra code beyond R7's translation leaving aborts alone.

**Rationale**: `RunnableWithFallbacks.invoke` calls `config.signal.throwIfAborted()` before each
runnable, so an aborted request never starts the fallback. `retryFailedCall` throws on
`AbortError` and `Cancel…` messages, so no retry starts (FR-005). The translation in R7 rethrows
the error unchanged when the signal is aborted, so a timeout still becomes the 504.

## R5. Seeing switches and the answering model

**Decision**: each composition branch is wrapped with
`withConfig({ metadata: { opspilotModel: <name>, opspilotModelRole: "primary" | "fallback" } })`.
`LlmCallCounter` reads that metadata:

- `handleChatModelStart(..., runId, ..., metadata)`: counts the run, remembers `runId -> model`,
  and when the role is `fallback` records a switch `{ from, to, error }`, where `from` is the
  last primary model seen and `error` the last error class from `handleLLMError`.
- `handleLLMError(error)`: remembers `error.name`.
- `handleLLMEnd(output, runId)`: sets `modelUsed` to the model of that run.

**Rationale**: config metadata is inheritable, so it reaches the chat model run even when the model
sits inside a structured output pipeline. The counter already rides every in-request call, so no
new plumbing is needed to collect switches.

**Alternatives considered**: the `retry:attempt:N` tags that `RunnableRetry` adds are
non-inheritable and get lost one level down (inside `withStructuredOutput`); `ls_model_name` is
present but cannot tell a fallback run from a primary one.

## R6. `llmCalls` counts retries

**Decision**: every started chat model run counts, retries included. FR-010 and User Story 2
scenario 4 were revised to match.

**Rationale**: with `withRetry`, each attempt is its own chat model run with its own callbacks.
Hiding retries would need the counter to rebuild the run tree from parent ids. Counting attempts
also tells the truth about how many requests reached the provider. SC-004 still holds: a call that
never fails counts once.

## R7. The 503

**Decision**: a new edge error `ModelUnavailableError` in `src/domain/errors.ts`, not a
`DomainError`, with `causeName` set to the class name of the error it wraps. The composition's
final step turns any error into it, unless the signal is aborted. `RunError` gains an optional
`cause` that `toRunError` fills from `causeName`. `toHttpReply` maps a run error named
`ModelUnavailableError`, from a `result` or a `thrown` outcome, to `503 model_unavailable`.

**Rationale**: run errors cross the strategy boundary as plain `RunError` data, so the edge can only
tell them apart by name, as `run-outcome.ts` already does for limit errors. `RunnableWithFallbacks`
rethrows its first error, which is the primary model's final error after its retries, so FR-011
names that class. The spec was revised from "last error" to match.

**Alternatives considered**: classify provider error classes (`RateLimitError`, `APIError`) at the
edge (fragile and leaks SDK names into HTTP code); a custom fallback loop to keep the last error
(re-implements `withFallbacks`).

## R8. Where `fallback` events sit in the trace

**Decision**: each step adds the counter's switches as `fallback` events before the events of the
model call that switched, where the step builds its trace call by call (router before `route`,
context before `summarize`, reflection's critic before `critique`, plan-execute's planner and
replanner before `plan`). ReAct builds its trace from the final messages, so its switches go at the
start of its events. The graph tags them with the node as it does every event.

**Rationale**: FR-007 only needs the switch to come before the events of the answer it produced.
Exact interleaving inside ReAct would need the message-to-call mapping the trace builder does not
have.

**Naming**: the trace already has `route.source: "fallback"` (the router failed and the default
route ran). The new event is `type: "fallback"` with `from` and `to` model names, so the two never
share a field.

## R9. `modelUsed` across graph nodes

**Decision**: `Metrics.modelUsed: string | null`. The graph state adds a `modelUsed` channel whose
reducer keeps the newest non-null value (`(a, b) => b ?? a`), fed by the context, router, and
strategy nodes in run order. Summarization runs inside the request in the `context` node, so its
switches are traced there; the spec's edge case was corrected. The learning reflector runs after
the reply and uses no counter, so it changes neither trace nor metrics.

## R10. Settings

**Decision**: `ModelSettings` adds `OPENROUTER_MODEL_FALLBACK` as an optional trimmed string. A pure
`fallbackModelOf(settings)` returns `undefined` when it is empty or equal to `OPENROUTER_MODEL`
(FR-002). `createModel(env)` keeps its signature, returns `BaseChatModel`, and builds the two
`ChatOpenAI` instances from shared options. A second export, `createResilientModel({ primary,
fallback?, attempts? })`, takes ready models so tests use `ScriptedChatModel` without network.

**Rationale**: `index.ts`, `arena.ts`, and `bench.ts` call `createModel()` and type the result as a
`BaseChatModel`, so they need no change. `README.md` gains the setting; `.env.example` is updated by
the user, since agents may not read env files.

## R11. Test speed

**Decision**: tests pass `attempts: 1` for most cases. One test covers a real retry with
`attempts: 2` and accepts the about 1 s `p-retry` wait.

**Rationale**: `withRetry` exposes no backoff option in `@langchain/core` 1.3.2.
