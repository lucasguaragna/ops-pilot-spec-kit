# Contract: model factory

## `createModel(env = process.env): BaseChatModel`

- Reads `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and the optional `OPENROUTER_MODEL_FALLBACK`.
- Throws `ConfigurationError` (field names only) when a required setting is missing.
- Builds the primary and, when set, the fallback `ChatOpenAI`, with the same options as today
  (`baseURL`, `temperature: 0`, `provider.require_parameters`) plus `maxRetries: 0`.
- Returns `createResilientModel({ primary, fallback })`.

## `createResilientModel({ primary, fallback?, attempts? }): BaseChatModel`

`primary` and `fallback` are `{ model: BaseChatModel; name: string }`. The models are ready-made,
so tests pass `ScriptedChatModel` instances; the names are what the trace and `modelUsed` show.
`attempts` is per model and defaults to `MODEL_ATTEMPTS` (2), as in the course reference.

| Method | Behaviour |
| --- | --- |
| `invoke(input, options)` | Runs the composition for plain calls |
| `bindTools(tools, kwargs)` | Binds on each model, then composes |
| `withStructuredOutput(schema, config)` | Calls it on each model, then composes |
| `withConfig(config)` | Inherited; the bound config reaches `invoke` |

The composition for each shape:

1. `shape(primary)` with metadata `{ opspilotModel, opspilotModelRole: "primary" }`, then
   `.withRetry({ stopAfterAttempt: attempts, onFailedAttempt: retryFailedCall })`.
2. When a fallback is set: `.withFallbacks([shape(fallback)])`, where the fallback carries
   `opspilotModelRole: "fallback"` and has the same `withRetry`.
3. A final step: when `options.signal` is aborted, the error is rethrown unchanged. Otherwise it is
   wrapped in `ModelUnavailableError` with `causeName = error.name`.

## `LlmCallCounter` additions

| Member | Meaning |
| --- | --- |
| `count` | Every started chat model run, retries included |
| `promptTokens` | Unchanged |
| `switches: Switch[]` | One per fallback run started, in order |
| `modelUsed: string \| null` | Model of the last run that finished |

A pure `fallbackEvents(switches): TraceEvent[]` turns switches into `fallback` events.

## Guarantees the tests check

- A failing primary with no fallback: `attempts` starts, then `ModelUnavailableError`.
- A failing primary with a fallback: `attempts` primary starts, 1 fallback start, 1 switch, and the
  fallback's answer is returned.
- A primary that fails once and then answers: no switch, and `modelUsed` is the primary.
- A non-retryable error (400): 1 primary start, then the fallback.
- An aborted signal: no fallback start, and the original abort error propagates.
- Tools and a structured output schema reach the fallback (the scripted fallback sees them).
