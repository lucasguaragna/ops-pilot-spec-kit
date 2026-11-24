# Contract: Learning reflector

Defined in `src/agents/learning-reflector.ts`, started by `runChat` in `src/http/chat-service.ts`.

## Interface

```ts
export const LEARNING_TOOL_NAME = "record_learning";
export const learningVerdictSchema: z.ZodType<{ hasLearning: boolean; fact: string }>;
export type LearningSkipReason = "no_learning" | "invalid_fact" | "secret";
export type LearningDecision = { kind: "save"; fact: string } | { kind: "skip"; reason: LearningSkipReason };
export type LearningOutcome =
  | { kind: "saved"; memory: Memory }
  | { kind: "duplicate"; memory: Memory }
  | { kind: "skipped"; reason: LearningSkipReason };

/** Pure: true when the text looks like it holds a credential. */
export function looksLikeSecret(text: string): boolean;
/** Pure: what to do with a verdict. */
export function factToSave(verdict: LearningVerdict): LearningDecision;
/** Pure: the system and human messages for one engineer message. */
export function learningMessages(message: string): BaseMessage[];

export interface LearningReflector {
  /** Resolves to the outcome; rejects on a model, structured-output, embedding, or abort failure. */
  learn(userId: string, message: string, signal: AbortSignal): Promise<LearningOutcome>;
}
export function createLearningReflector(options: { model: BaseChatModel; memories: MemoryStore }): LearningReflector;
```

## Model call

- Binding: `withStructuredOutput(learningVerdictSchema, { name: "record_learning", method:
  "functionCalling", includeRaw: true })`.
- Called through `structured("learning reflector", …)`: up to 5 attempts.
- Input: `learningMessages(message)`, a system message with the rules below and a human message
  `The engineer's message:\n<message>`. No history, no recalled memories, no trace.
- The `signal` is passed in the call config. The reflector calls `signal.throwIfAborted()` before
  `remember`, so an abort after the model answered writes nothing.

## Prompt rules (system message, in substance)

1. Decide whether the message states a fact that will still be true after this request: who owns
   what, which team the engineer is on, how they like answers, quirks of their systems.
2. Requests, questions, and the current state of an alert or incident are not lasting facts.
3. Never put a password, key, token, connection string, or any other credential in the fact, not
   even partly. If the only lasting content is a secret, answer `hasLearning: false`.
4. At most one fact: the most useful one.
5. Write the fact as one short English sentence that makes sense on its own, about "the engineer".
6. When there is no lasting fact, `hasLearning: false` and `fact: ""`.

## Service integration

```text
runChat:
  … run, save the exchange (unchanged) …
  if shouldLearn(userId, outcome):
    background.track(
      runWithTimeout(signal => reflector.learn(userId, request.message, signal), learningTimeoutMs)
        .then(timed => logLearning(userId, timed, learningTimeoutMs)))
  return outcome            // never waits for the task
```

- `shouldLearn(userId, outcome)`: `userId !== undefined && outcome.kind === "result" &&
  outcome.result.stopReason === "completed"`.
- The reflector is built per request with `dependencies.model` and `settings.memories`.
- `logLearning` takes `learningTimeoutMs` because the `timeout` case of `TimedRun` carries no
  duration; the timeout log line prints that value.
- The tracked promise never rejects.

## Log lines

| Result | Stream | Line |
| --- | --- | --- |
| `saved` | `console.log` | `Learned [memory <id>] for <userId>` |
| `duplicate` | `console.log` | `Learning already known as [memory <id>] for <userId>` |
| `skipped: secret` | `console.warn` | `Learning skipped for <userId>: secret` |
| `skipped: invalid_fact` | `console.warn` | `Learning skipped for <userId>: invalid_fact` |
| `skipped: no_learning` | none | |
| thrown | `console.error` | `Learning failed for <userId>: <name>: <message>` |
| timeout | `console.error` | `Learning timed out after <ms> ms for <userId>` |

A fact the step did not save is never written to the log.

## HTTP

`POST /chat` is unchanged: same request schema, same reply schema, same status codes, same
`metrics` (the step's model calls are not counted in `llmCalls`). See
[008 chat-api](../../008-semantic-memory/contracts/chat-api.md).
