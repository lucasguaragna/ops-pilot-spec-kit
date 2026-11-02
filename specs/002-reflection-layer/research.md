# Research: Reflection Layer

## Decorator shape

- **Decision**: `withReflection(strategy, { model, maxReflections = 2 })` returns a
  `ReasoningStrategy`. It only calls `strategy.run(input, options)` and reads the `RunResult`.
- **Rationale**: Any strategy works without changes, which is what the user asked for. The model is
  passed in so the critic uses the same model as the strategy (FR-004) and tests can pass a fake.
- **Alternatives considered**: A graph node inside each strategy, which would need one change per
  strategy and break the "any strategy" goal.

## Critic verdict

- **Decision**: Structured output with function calling and `includeRaw`, validated by a zod schema:
  `{ approved: boolean, feedback: string, fix?: "rerun" | "rewrite" }`, refined so a rejection needs
  `fix`. One retry on a missing or invalid verdict; then the last answer is kept (see "Critic failure").
- **Rationale**: This is the pattern already verified on OpenRouter for the planner. A rejection
  without `fix` cannot be routed, so it counts as invalid (spec edge case).
- **Alternatives considered**: Two critic calls (judge, then classify), which doubles the cost.

## Shared retry helper

- **Decision**: Move `structured()` and `STRUCTURED_ATTEMPTS` from `plan-and-execute.ts` to
  `src/agents/structured-output.ts`, used by the planner, replanner, and critic.
- **Rationale**: Same behavior in three places; one copy keeps it consistent.
- **Alternatives considered**: Copying the helper, which drifts.

## What the critic sees

- **Decision**: The original request, the latest answer, and every `observation` from all attempts
  so far, in order.
- **Rationale**: Reruns change `data/db.json`, so later observations reflect the latest state, while
  earlier ones show what was already done. The critic does not need thoughts or plans to check facts.
- **Alternatives considered**: Only the latest attempt's observations, which hides actions a rerun
  was told not to repeat.

## Rerun input

- **Decision**: A pure function builds the new input: the original request, the critic feedback, and
  the list of actions already taken (tool, arguments, result), with an instruction not to repeat
  them.
- **Rationale**: The input is the only channel into a generic strategy. Listing results such as
  `INC-001` lets the model refer to existing incidents instead of opening new ones.
- **Alternatives considered**: Resetting `data/db.json` before a rerun, which would hide real side
  effects and differ from production behavior.

## Rewrite call

- **Decision**: One model call without tools: system prompt plus the request, the observations, the
  rejected answer, and the feedback. The reply text is the new answer.
- **Rationale**: Fixes unsupported claims without side effects (spec User Story 2, scenario 5).
- **Alternatives considered**: Structured output for the rewrite, which adds nothing for plain text.

## Counting and stopping

- **Decision**: An `LlmCallCounter` counts critic and rewrite calls; base attempts add their own
  `metrics.llmCalls`. Latency is measured around the whole run. The loop stops on approval, after
  `maxReflections` regenerations, or when an attempt stops by limit or error.
- **Rationale**: Meets FR-008 and FR-009 with the existing counter.
- **Alternatives considered**: Passing the counter into base strategies, which would change their
  interface.

## Critique event shape

- **Decision**: `{ type: "critique", approved: boolean, fix?: "rerun" | "rewrite", content: string }`,
  printed as `[critique] approved: <feedback>` or `[critique] rejected (rerun): <feedback>`.
- **Rationale**: FR-005 needs the verdict readable in the trace. The event was reserved with only
  `content`, and no strategy emitted it, so widening it breaks nothing.
- **Alternatives considered**: Encoding the verdict inside `content`, which tests could not check.

## Live validation (2026-11-02, `openrouter/free`)

- `react,reflect:react` on "how many critical alerts are firing?": both answered correctly;
  `reflect:react` added one approving critique and cost 3 calls instead of 2.
- `reflect:plan-execute` on the three-incident request: the order was kept, `catalog` was reported
  as missing instead of swapped for another service, and the answer matched `data/db.json`
  (INC-001 resolved, INC-002 open). The critic approved on the first try; 10 calls.
- The critic often returns empty feedback when it approves; `formatEvent` then prints
  `[critique] approved` without a colon.
- A run on "faça um resumo do estado do plantão..." ended with `The critic returned no structured
  output after 2 attempts`. Probing showed `openrouter/free` sometimes routes to a model without
  tool support (for example `cohere/north-mini-code:free`) that answers in plain text. The model
  factory now sends `provider: { require_parameters: true }`, so OpenRouter only picks models that
  honor the forced tool call; 6 of 6 probes and the rerun of that request then returned a valid
  verdict.

## Critic failure

- **Decision**: When the critic fails twice or the rewrite call fails, return the last answer with
  stop reason `completed` and a `thought` event `Reflection skipped, answer kept: <message>`.
  Failures of the base strategy, including a rerun, still end the run with their own stop reason.
- **Rationale**: Reflection audits an answer that already exists. A live run lost a correct answer
  (`Answer: (none)`) only because the critic call failed; keeping it matches what the base strategy
  alone would have returned, and the trace still shows the reflection was skipped.
- **Alternatives considered**: Stop reason `error`, the first design, which discards a finished
  answer for an auditing failure.
