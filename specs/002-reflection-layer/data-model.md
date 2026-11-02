# Data Model: Reflection Layer

Builds on [001 data-model](../001-reasoning-nucleus/data-model.md). Store entities are unchanged.

## Verdict

The critic's structured output, validated with zod.

| Field | Type | Rule |
| --- | --- | --- |
| `approved` | boolean | Required |
| `feedback` | string | Required; may be empty when approved |
| `fix` | `"rerun"` \| `"rewrite"` | Required when `approved` is false; ignored when true |

## ReflectionOptions

| Field | Type | Rule |
| --- | --- | --- |
| `model` | chat model | The same model the strategies use |
| `maxReflections` | integer | `>= 0`, default `2`; invalid values throw when the decorator is created |

## TraceEvent change

`critique` becomes `{ type: "critique"; approved: boolean; fix?: "rerun" | "rewrite"; content: string }`.
`content` holds the feedback. Every other event is unchanged.

## Attempt

Internal to one reflected run.

| Kind | Produces |
| --- | --- |
| Base | The base strategy's `RunResult` for the original input |
| Rerun | The base strategy's `RunResult` for the rerun input |
| Rewrite | An answer event and one LLM call |

## Reflected RunResult

Same `RunResult` type as any strategy.

- `trace`: attempts in order, each followed by its critique when one was made.
- `answer`: the last attempt's answer.
- `stopReason`: the last attempt's stop reason, `completed` with the last answer when the critic or the rewrite fails, plus a `thought` event
  `Reflection skipped, answer kept: <message>`.
- `metrics.llmCalls`: sum of every attempt's calls plus critic and rewrite calls.
- `metrics.latencyMs`: the whole run.

## Loop

```text
attempt = base run
repeat:
  if attempt did not complete: stop with it
  verdict = critic
  if approved or regenerations == maxReflections: stop with attempt
  attempt = rerun or rewrite, per verdict.fix
```

With the default of 2: at most 3 attempts and 3 critiques.
