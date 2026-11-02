# Contract: `POST /chat`

Field rules are in [data-model.md](../data-model.md). All bodies are JSON.

## Request

```json
{ "message": "Which alerts are firing?", "strategy": "react", "reflect": false }
```

`strategy` is optional (default `react`). `message` and `reflect` are required.

## Replies

### 200: run finished

```json
{
  "answer": "Two alerts are firing: ...",
  "stopReason": "completed",
  "trace": [
    { "type": "action", "tool": "list_alerts", "args": { "status": "firing" } },
    { "type": "observation", "tool": "list_alerts", "content": "[...]" },
    { "type": "answer", "content": "Two alerts are firing: ..." }
  ],
  "metrics": { "llmCalls": 2, "latencyMs": 1840 }
}
```

At the iteration limit: `"answer": null`, `"stopReason": "iteration_limit"`.

### 400: invalid body

```json
{
  "error": "invalid_body",
  "message": "The request body is invalid",
  "issues": [
    { "path": ["message"], "message": "Too small: expected string to have >=1 characters" },
    { "path": ["reflect"], "message": "Invalid input: expected boolean, received undefined" }
  ]
}
```

Body that is not JSON: one issue with `"path": []` and a message saying the body is not valid JSON.

### 422: unknown strategy

```json
{
  "error": "unknown_strategy",
  "message": "Unknown strategy \"chain-of-thought\". Known: react, plan-execute",
  "strategy": "chain-of-thought",
  "knownStrategies": ["react", "plan-execute"]
}
```

### 502: run failed

```json
{
  "error": "run_failed",
  "message": "The run stopped with an error",
  "runError": { "name": "Error", "message": "The run failed; details are in the server log" },
  "trace": [],
  "metrics": { "llmCalls": 1, "latencyMs": 320 }
}
```

`trace` and `metrics` are left out when the run threw instead of returning a result. `runError.name`
is the error class; the message is always the fixed text above, because the real one can come from
the model provider. The real error is written to the server log.

The server listens on `127.0.0.1` unless `HOST` is set, because the endpoint has no authentication.

### 504: timeout

```json
{ "error": "timeout", "message": "The run did not finish within 180000 ms", "timeoutMs": 180000 }
```

The run is cancelled when this reply is sent; no later reply follows.

## Server factory (for tests and `src/index.ts`)

```ts
interface AppSettings {
  registry: StrategyRegistry;                      // name -> factory
  createDependencies: () => StrategyDependencies;  // model and tools for one request
  timeoutMs?: number;                              // default 180_000
  maxIterations?: number;                          // default 10
}
createApp(settings: AppSettings): express.Express
```

Other methods and paths fall through to Express's default 404.
