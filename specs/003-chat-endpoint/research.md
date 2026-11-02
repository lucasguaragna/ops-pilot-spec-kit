# Research: Chat Endpoint

All Technical Context items were resolved from the installed packages and the existing code; none
needed clarification. Each decision below lists what was chosen, why, and what was rejected.

## R1. Cancelling a run on timeout

- **Decision**: Add `signal?: AbortSignal` to `RunOptions`. `react` passes it to `agent.stream`,
  `plan-execute` passes it to `graph.stream`, and `withReflection` passes the same `runOptions` to
  every base attempt and adds the signal to the config of the critic and rewrite calls. The
  reflection loop also calls `signal?.throwIfAborted()` before each new base attempt or critic call.
- **Rationale**: `RunnableConfig.signal` exists in the installed `@langchain/core`
  (`runnables/types.d.ts`), and `@langchain/langgraph` merges `options.signal` into the run and
  hands `config.signal` to every node (`pregel/index.js`). Nodes already forward `config` to
  `model.invoke` and `tool.invoke`, so one signal reaches every model and tool call with no polling.
  An aborted run ends through the existing `catch` as `stopReason: "error"` with an `AbortError`;
  the HTTP layer has already sent 504, so that result is discarded.
- **Alternatives considered**: LangGraph `RunControl.requestDrain()` stops only after the current
  superstep and does not cancel in-flight work, as its docs state, so it misses FR-009a. A shared
  "cancelled" flag checked in each node would duplicate what the signal already does.

## R2. Enforcing the timeout

- **Decision**: A small helper `runWithTimeout(run, timeoutMs)` in `src/http/chat-service.ts`. It
  creates an `AbortController`, calls `run(signal)`, and races it against a timer. On timeout it
  aborts the controller and resolves `{ kind: "timeout" }`; the timer is always cleared. The
  timeout is a field of the app settings (default 180 000 ms) so tests pass about 50 ms.
- **Rationale**: Keeps the side effect (the timer) in one place and makes the race testable without
  HTTP. Clearing the timer keeps tests from hanging on a pending timer.
- **Alternatives considered**: `AbortSignal.timeout(ms)` alone gives a signal but no reply, and its
  timer cannot be cleared. A server-level socket timeout (`server.requestTimeout`) closes the socket
  instead of sending a 504 body.

## R3. Strategy registry

- **Decision**: `src/agents/index.ts` exports `strategyFactories` (`react`, `plan-execute`), the
  `StrategyRegistry` type (name to factory), and a pure
  `createStrategy(registry, name, dependencies, { reflect })`. It looks the name up with
  `Object.hasOwn`, throws `UnknownStrategyError` with the known names when missing, and wraps the
  result with `withReflection(strategy, { model: dependencies.model })` when `reflect` is true.
  The arena derives its names (`react`, `plan-execute`, `reflect:react`, `reflect:plan-execute`)
  from the same registry and calls `createStrategy` with `reflect` set from the prefix.
- **Rationale**: One registry for arena and HTTP (SC-005). `Object.hasOwn` makes names such as
  `toString` or `constructor` unknown instead of resolving to `Object.prototype` members.
- **Alternatives considered**: Keeping `reflect:` entries in the registry would let the HTTP body
  ask for reflection two ways, which the spec rejects (`reflect:react` gives 422).

## R4. Express 5 errors and body validation

- **Decision**: `express.json()` parses the body. A final error middleware turns body-parser errors
  (`type: "entity.parse.failed"`, status 400) into the same 400 body as zod issues and anything
  else into a generic 500 with no stack. The route handler is `async`; Express 5 forwards rejected
  promises to `next(error)`, so no wrapper is needed.
- **Rationale**: With no JSON body, Express 5 leaves `req.body` as `undefined`, which zod rejects,
  so a missing body and a wrong body share one path. A 500 is reserved for bugs, such as a reply
  that fails its own schema (FR-010).
- **Alternatives considered**: Validation middleware packages add a dependency the constitution does
  not allow without need; zod `safeParse` in the controller is enough.

## R5. Request and reply schemas

- **Decision**: `src/http/schemas.ts` holds `ChatRequest`
  (`message: z.string().trim().min(1)`, `strategy: z.string().default("react")`,
  `reflect: z.boolean()`), `TraceEventSchema`, `MetricsSchema`, `ChatReply`, and `ErrorReply`.
  `z.object` strips unknown keys, so extra fields are ignored. Names are compared as sent, so
  `React` is unknown.
- **Rationale**: The strategy is a plain string at the schema level because the known names live
  in the injected registry; checking it after validation gives 400 before 422 as the spec orders.
- **Alternatives considered**: A `z.enum` built from the registry would merge 400 and 422 into one
  status.

## R6. Integration tests without network

- **Decision**: `src/http/server.test.ts` builds the app with a fake registry and fake dependencies,
  listens on port 0, and calls it with the global `fetch`. Fake strategies: a fixed answer, an
  iteration-limit result, an error result, a throwing run, and a run that waits on the signal and
  records that it was aborted. Reflection uses the existing `ScriptedChatModel` with a scripted
  approving verdict.
- **Rationale**: Real HTTP covers Express parsing and status codes (FR-013); port 0 avoids
  collisions; a 50 ms timeout keeps the suite under 5 seconds (SC-004).
- **Alternatives considered**: `supertest` is a new dependency; calling the handler directly skips
  `express.json()` and the error middleware.

## R7. Starting the server

- **Decision**: `src/index.ts` reads `PORT` with zod (default 3000), builds the model once with
  `createModel()` and the tools per request over the JSON file store, and listens. The `dev` script
  becomes `node --env-file-if-exists=.env --import tsx src/index.ts`, like `arena` and `bench`.
- **Rationale**: Today `npm run dev` runs `tsx src/index.ts` without loading `.env`, so the
  OpenRouter key would be missing. Tools are built per request so each run sees the current file.
- **Alternatives considered**: Reading `.env` in code would break the rule that agents never read
  it; Node loads it at startup instead.
