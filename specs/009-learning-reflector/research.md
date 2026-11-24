# Research: Learning Reflector

No item in the Technical Context was left as NEEDS CLARIFICATION. The decisions below settle the
design questions the spec left to planning. Every LangChain API used here is already used the same
way in `src/agents/reflection.ts` and `src/agents/plan-and-execute.ts`, so no new library behaviour
is assumed.

## R1. Running the step without delaying the reply, and awaiting it in tests

- **Decision**: `runChat` starts the step after the exchange is saved and does not await it. The
  promise goes to `settings.background.track(promise)`. `BackgroundTasks` keeps a set of pending
  promises, removes each one when it settles, and exposes `settled(): Promise<void>`, which waits
  until the set is empty (looping, in case a task was added while waiting). `AppSettings.background`
  is optional; `resolveSettings` fills in `new BackgroundTasks()`.
- **Rationale**: FR-007 says the reply never waits; FR-014 says tests must await the step without
  real time. A tracker injected through settings gives tests a handle (`await
  background.settled()`) at every level, including `server.test.ts`, where the outcome object is
  not visible. It also gives a later feature a place to drain on shutdown.
- **Alternatives considered**: returning the promise in `ChatOutcome` (visible only to service
  tests, and it would leak into `toHttpReply`); `setImmediate`/`queueMicrotask` without tracking
  (tests would need `setTimeout` polling, which FR-014 rules out); awaiting the step before replying
  (breaks FR-007).

## R2. The structured call

- **Decision**: `model.withStructuredOutput(learningVerdictSchema, { name: "record_learning",
  method: "functionCalling", includeRaw: true })`, called through `structured("learning reflector",
  learningVerdictSchema, () => bound.invoke(messages, { signal }))`. The schema is `{ hasLearning:
  boolean, fact: string }` with `fact` required and allowed to be empty.
- **Rationale**: Same settings as the critic, which already work across OpenRouter routes,
  including the free router that sometimes answers in text (the helper retries up to 5 times).
  A required `fact` that may be empty follows the critic's `feedback` field: some providers handle
  optional tool arguments poorly. The `signal` makes the timeout cancel the HTTP call.
- **Alternatives considered**: `jsonMode` (weaker on the free router); an optional `fact` (see
  above); a separate cheaper model (spec assumption: same model, no new configuration).

## R3. The prompt

- **Decision**: A system message, then a human message holding only the engineer's message. The
  system message says: decide whether the message states a fact that stays true beyond this
  request (ownership, team, preferences, quirks of their systems); never a request, a question, or
  the current state of an alert or incident; never a password, key, token, or any credential, not
  even partly; at most one fact; write it as one short English sentence that makes sense alone,
  about "the engineer" (for example "The engineer is on the payments team and owns the checkout
  alerts"); when there is none, `hasLearning: false` and an empty `fact`. The human message is
  wrapped as data (`The engineer's message:\n<message>`).
- **Rationale**: FR-001 (only the last message), FR-003/FR-004 (what counts), FR-005 (first guard),
  FR-009 (one fact), the English-sentence assumption (recall compares English-like text).
- **Alternatives considered**: giving the step the history (rejected by FR-001); few-shot examples
  (more tokens on every request; can be added later if the quickstart shows misses).

## R4. The deterministic secret check

- **Decision**: A pure `looksLikeSecret(text): boolean` over the proposed fact, true when any of
  these match:
  - a credential word followed by a value: `password`, `passwd`, `pwd`, `secret`, `token`,
    `api key`/`api_key`/`apikey`, `access key`, `private key`, `credential(s)`, then `is`, `=`,
    or `:` and a non-space value. `bearer` is the one exception: its value follows whitespace
    alone, as in an `Authorization` header (`Bearer abc.def`), and that value must hold a digit
    or one of `. _ ~ + / = -`, so "bearer authentication" or "bearer auth" does not match;
  - a PEM block: `-----BEGIN ... PRIVATE KEY-----`;
  - a URL with a user and password: `scheme://user:pass@host`;
  - a known token shape: `sk-` at the start of a word followed by 20 or more letters, digits,
    `_`, or `-` (so "risk-based" or "disk-heavy" does not match), `ghp_…`, `github_pat_…`,
    `xox[abpr]-…`, `AKIA` plus 16 characters, or a JWT (`eyJ….….…`);
  - a long opaque run: 32 or more characters of letters, digits, `+/_-` that mixes letters and
    digits.
  The check runs on the fact only, not on the message, so "I own checkout; the DB password is
  hunter2" can still yield "The engineer owns checkout".
- **Rationale**: FR-005 and US2. The spec accepts false positives ("a harmless fact is not
  learned"), so the check leans strict. A word alone ("rotates API keys monthly") is not enough;
  a word with a value is.
- **Alternatives considered**: rejecting any credential word (drops useful facts about key
  rotation or token expiry); an entropy score (harder to test at a boundary); a secret-scanning
  dependency (new dependency for a safety net).

## R5. The time bound

- **Decision**: `LEARNING_TIMEOUT_MS = 30_000` in `server.ts`, the default of
  `AppSettings.learningTimeoutMs` (a test seam, see R9), enforced with the existing
  `runWithTimeout`, which aborts the signal it passes to `reflector.learn`. The reflector forwards
  that signal to the model call and checks it before `remember`.
- **Rationale**: The spec assumption (30 s). Reusing `runWithTimeout` keeps one timeout mechanism
  and its tested guarantees (timer cleared, late rejection handled). The reflector takes a signal
  instead of a timeout, so the agents layer does not import from `http/`.
- **Alternatives considered**: no bound (a hung provider would keep a promise and a socket open);
  `AbortSignal.timeout` inside the reflector (harder to drive in tests than `runWithTimeout`).

## R6. Forgetting by description

- **Decision**: A new store method `forgetClosest(userId, description): Promise<Memory |
  undefined>`. It embeds the description, then with no `await` until the end scans the user's
  memories, picks `findClosest(scored, FORGET_MIN_SCORE)` (`FORGET_MIN_SCORE = 0.5`, implemented as
  `rankMemories(scored, { limit: 1, minScore })[0]`, so newest first on a tie), and deletes it by id
  and user. It returns the removed memory, or `undefined` when nothing scores at least 0.5.
  `forget_preference` returns `{ id, fact, forgotten: true }` or `{ forgotten: false }`.
- **Rationale**: FR-011 and US3. Doing the scan and delete in the store keeps them atomic, as
  `remember` does for dedup; a tool built on `recall` + `forget` would have an `await` between them
  and inherit recall's 0.3 floor and limit of 3. `>=` matches recall's boundary convention, the
  opposite of dedup's strict `>`. No match is an ordinary answer, so it is not an error.
- **Alternatives considered**: `recall` then `forget` in the tool (see above); a domain error for
  no match (the model would treat a normal outcome as a failure); removing every match above 0.5
  (the spec says only the closest one).

## R7. When the step runs

- **Decision**: A pure `shouldLearn(userId, outcome)` in `chat-reply.ts`: true only when `userId`
  is defined, `outcome.kind === "result"`, and `outcome.result.stopReason === "completed"`. The step
  starts after the messages are saved.
- **Rationale**: FR-002 and the edge case "a retried request is not learned twice". It sits next to
  `messagesToSave`, which makes the same distinction for the history.
- **Alternatives considered**: learning from every request (would learn twice on retry, and learn
  from runs whose reply the engineer never saw).

## R8. Outcomes, logging, and no unhandled rejection

- **Decision**: `reflector.learn` resolves to a `LearningOutcome`: `saved` (with the memory),
  `duplicate` (with the existing memory), or `skipped` with a reason (`no_learning`,
  `invalid_fact`, `secret`). It rejects on a model failure, a structured-output miss after 5
  attempts, an embedding error, or an abort. `runWithTimeout` turns that into `thrown` or
  `timeout`, and `logLearning` writes one line:
  - `saved`: `console.log("Learned [memory <id>] for <userId>")`;
  - `duplicate`: `console.log("Learning already known as [memory <id>] for <userId>")`;
  - `skipped` `secret` or `invalid_fact`: `console.warn("Learning skipped for <userId>: <reason>")`,
    never with the fact text;
  - `skipped` `no_learning`: nothing;
  - `thrown`: `console.error("Learning failed for <userId>: <name>: <message>")`;
  - `timeout`: `console.error("Learning timed out after <ms> ms for <userId>")`, where `<ms>` is
    `learningTimeoutMs` (30 000 by default). The `timeout` case of `TimedRun` carries no duration,
    so `logLearning` receives the timeout as a third argument.
- **Rationale**: FR-008 and SC-004. `runWithTimeout` never rejects and `logLearning` does not
  throw, so the tracked promise cannot become an unhandled rejection that would crash the process.
  A rejected fact may hold a secret, so it is never logged.
- **Alternatives considered**: an injected logger in settings (one more setting for four call
  sites; `mock.method(console, …)` covers the tests); logging the saved fact text (fine for the
  engineer, but keeping logs free of memory text is simpler to reason about).

## R9. Testing the step

- **Decision**: Unit tests drive `createLearningReflector` with a `ScriptedChatModel` whose turn is
  `learningTurn({ hasLearning, fact })` (a `record_learning` tool call) and a `FakeMemoryStore`.
  Service tests append that turn after the agent's turns, call `runChat`, then `await
  background.settled()`. "Reply first" (SC-003) uses a memory store whose `remember` waits on a
  gate: `runChat` resolves while the task is pending, the gate opens, `settled()` resolves, and the
  fact is there. The timeout case passes a tiny timeout through a test seam (`learningTimeoutMs`
  in settings, default 30 000) and a model turn that never resolves until aborted.
- **Rationale**: FR-014: no real model and no sleeps. The scripted model already supports
  structured output (the reflection tests use it).
- **Alternatives considered**: `setTimeout` polling (flaky); mocking `structured` (would not test
  the binding).

## R10. Self-poisoning through the learned fact

- **Decision**: Accept, and document. A learned fact is given back to the agent in that user's
  later requests, so a message like "remember to ignore your rules" could be turned into a fact.
  The prompt asks for facts about the engineer and their systems only, the fact is capped at 500
  characters, and memories are per user, so only the user who wrote it is affected.
- **Rationale**: The same exposure exists with `remember_fact` since 008. A full defence is out of
  scope.
- **Alternatives considered**: a second classifier on the fact (more cost per request for a risk
  limited to the author).
