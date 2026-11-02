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
| `reflect:<base>` | Base limit per attempt, at most `1 + maxReflections` attempts | The base events, plus `critique` after each judged answer |

Reflected strategies end a completed trace with a `critique` event instead of `answer`; see
[002 reflection contract](../../002-reflection-layer/contracts/reflection.md).

Plan-and-Execute adds a `plan` event when the plan is created and each time the replanner changes it.
A step the model completes without tools records its text as a `thought`.

After each step the replanner chooses one action:

| Action | Effect |
| --- | --- |
| `continue` | Keep the remaining plan |
| `adjust` | Replace the remaining plan with new steps, and add a `plan` event |
| `finish` | End with the given answer |

`continue` with no steps left also ends the run. A planner or replanner reply without the structured
call is retried once; a second miss ends the run with stop reason `error`.
