# Contract: ReasoningStrategy

```ts
interface RunOptions {
  maxIterations: number;
}

interface ReasoningStrategy {
  name: string;
  run(input: string, options: RunOptions): Promise<RunResult>;
}
```

`RunResult` is defined in [data-model.md](../data-model.md).

## Rules

- `run` MUST NOT reject for a limit or a provider failure. It returns a `RunResult` with the matching
  `stopReason` and the trace so far.
- `metrics.llmCalls` counts every model call in the run.
- `metrics.latencyMs` covers the whole run.
- A completed run's trace ends with one `answer` event.
- Every `action` event is followed by an `observation` event for the same tool.

## Strategies

| `name` | Limit | Trace events |
| --- | --- | --- |
| `react` | `maxIterations` model turns | `thought`, `action`, `observation`, `answer` |
| `plan-execute` | `min(maxIterations, 8)` steps | `plan`, `action`, `observation`, `thought`, `answer` |

Plan-and-Execute adds a `plan` event when the plan is created and each time the replanner changes it.
A step the model completes without tools records its text as a `thought`.
