# Contract: Reflection

```ts
interface ReflectionOptions {
  model: BaseChatModel;
  maxReflections?: number; // default 2
}

function withReflection(strategy: ReasoningStrategy, options: ReflectionOptions): ReasoningStrategy;
```

`ReasoningStrategy` and `RunResult` are defined in
[001 reasoning-strategy](../../001-reasoning-nucleus/contracts/reasoning-strategy.md).

## Rules

- The returned strategy is named `reflect:<base name>`.
- `run` follows the same rules as any strategy: it never rejects for a limit, provider, or critic
  failure.
- Only completed attempts are critiqued. An attempt that stops by limit or error ends the run.
- When the critic fails twice or the rewrite call fails, the run keeps the last answer with stop
  reason `completed` and adds `[thought] Reflection skipped, answer kept: <message>`.
- Each critique adds one `critique` event right after the attempt it judges.
- Regenerations never exceed `maxReflections`.
- A rerun calls the base strategy with the rerun input; a rewrite calls the model once without
  tools and adds one `answer` event.
- `metrics.llmCalls` includes base attempts, critiques, rewrites, and critic retries.

## Trace example

```text
[action] resolve_incident {"id":"INC-001"}
[observation] resolve_incident: Error: Incident not found: INC-001
[answer] INC-001 is resolved.
[critique] rejected (rewrite): No observation shows INC-001 resolved; the tool returned an error.
[answer] INC-001 could not be resolved: it does not exist.
[critique] approved: The answer matches the observations.
```

## Arena

`--strategies` accepts `reflect:react` and `reflect:plan-execute` in addition to the existing names.
No new flag; `maxReflections` uses its default.
