# Research: Reasoning Nucleus

Checked against the installed packages and the LangGraph documentation on 2026-11-01. Behavior that
needs a live provider is marked as unverified.

## ReAct agent API

- **Decision**: Use `createAgent` from the `langchain` package, version 1.6.
- **Rationale**: The installed `@langchain/langgraph` marks `createReactAgent` as deprecated and names
  `createAgent` as its replacement. It runs on LangGraph and supports `stream`.
- **Alternatives considered**: `createReactAgent`, which needs no new dependency but will be removed.

## Capturing a partial trace

- **Decision**: Run with `stream(..., { streamMode: "values" })` and keep the latest messages.
- **Rationale**: `invoke` loses state when a limit or provider error is thrown. The spec requires a
  partial trace on both.
- **Alternatives considered**: Callback-built traces, which spread logic and are harder to test than
  one pure function over messages.

## Iteration limits

- **Decision**: One iteration is one model turn with its tool calls. ReAct uses
  `modelCallLimitMiddleware({ runLimit: maxIterations, exitBehavior: "error" })` and treats a thrown
  error named `ModelCallLimitMiddlewareError` as `stopReason: "iteration_limit"`. The class is not
  exported, so the check uses `error.name`. Plan-and-Execute uses an explicit counter
  with a cap of `min(maxIterations, 8)` steps. Both keep a recursion limit only as a safety net.
- **Rationale**: The middleware counts model calls directly, so the flag keeps one meaning. With
  `"error"`, the run's end is unambiguous; with `"end"`, a limit stop must be told apart from a
  normal finish.
- **Alternatives considered**: Mapping the flag to `recursionLimit`, which counts graph super-steps
  and depends on the agent's internal nodes.

## Counting LLM calls

- **Decision**: A callback handler with `handleChatModelStart`, passed in the run config and applied
  to every model call.
- **Rationale**: It counts each attempt in one place for both strategies, including structured
  output calls.
- **Alternatives considered**: Manual increments in each node, which miss the prebuilt agent's calls.

## OpenRouter model

- **Decision**: `ChatOpenAI` with `configuration.baseURL` set to `https://openrouter.ai/api/v1`,
  validated environment values, and `temperature: 0`. The factory reads the environment only when
  called, so importing it never fails.
- **Rationale**: OpenRouter exposes an OpenAI-compatible endpoint.
- **Unverified**: No credentials exist yet. Confirm after the OpenRouter class.

## Planner structured output

- **Decision**: `withStructuredOutput(schema, { method: "functionCalling", includeRaw: true })`,
  validating `parsed` with zod and retrying once when it is missing or invalid.
- **Rationale**: Tool calling is the option most OpenRouter models support. With `includeRaw`, a
  reply without the tool call gives `parsed: null` instead of throwing, so it can be told apart from
  a provider failure.
- **Alternatives considered**: JSON schema mode, whose support varies per model.
- **Verified**: 2026-11-02 with `OPENROUTER_MODEL=openrouter/free`, which routes each call to a
  different free model. Before the retry, some calls returned no structured output.

## Plan-and-Execute executor

- **Decision**: For each step, the executor makes one model turn with tools bound, runs its tool
  calls, records the action and observation, and pushes `[step, result]` to `done`. The replanner
  then chooses `continue`, `adjust`, or `finish`.
- **Rationale**: This keeps one step per executor pass, so the 8-step cap is exact and LLM calls stay
  predictable.
- **Alternatives considered**: A nested ReAct agent per step, which hides tool calls inside a step
  and makes the cap and the trace less exact.

## Store shape

- **Decision**: Pure transition functions over an immutable state, wrapped by a small holder that
  tools call.
- **Rationale**: This meets the pure function principle and keeps tests deterministic. Incident
  identifiers are sequential (`INC-001`) so runs can be compared.
- **Alternatives considered**: A mutable class, which is simpler but breaks the constitution.

## JSON database

- **Decision**: The holder takes a backend. Tests use memory; the seed command and the arena use
  `data/db.json`, read on every call and written through a temporary file and rename.
- **Rationale**: The user wants data to persist between runs until MySQL arrives, while tests stay
  deterministic. Reading on every call shows manual edits to the file.
- **Alternatives considered**: Loading once per process, which hides manual edits.

## Loading environment variables

- **Decision**: `arena` runs with `node --env-file-if-exists=.env --import tsx src/arena.ts`.
- **Rationale**: It is native to Node, as the project requires, and works before `.env` exists.
- **Alternatives considered**: `process.loadEnvFile()`, which throws when the file is missing.
