# Research: Persistent Conversation

No item in the Technical Context was left as NEEDS CLARIFICATION. Each decision below settles a
design question the spec left to planning.

## R1. How history reaches the agent

- **Decision**: A pure function `composeInput(history, message)` turns the earlier messages and the
  new message into one input string. A decorator `withHistory(strategy, history)` returns a
  `ReasoningStrategy` whose `run(input)` calls `strategy.run(composeInput(history, input))`. The
  chat service wraps the strategy it gets from `createStrategy` (base or reflection) with it. When
  the history is empty, `composeInput` returns the message unchanged.
- **Rationale**: Every strategy already takes `run(input: string, …)`, and reflection already
  wraps a strategy the same way (`withReflection`). Wrapping on the outside means react,
  plan-execute, and reflection all get history without changes (FR-007). The critic in reflection
  also sees the earlier turns, so it can judge a follow-up such as "the worst one". Returning the
  message unchanged for an empty history keeps every existing request and test working the same
  way (SC-006).
- **Alternatives considered**:
  - Pass history as real chat messages (`user` and `assistant` turns) into each strategy. This
    fits react a little better, but it changes the `ReasoningStrategy` interface and needs separate
    code in plan-execute (planner, executor, replanner, responder) and in reflection. Rejected
    because FR-007 asks for one path that works for every strategy.
  - Build the string inside the chat service without a decorator. This works, but `withHistory`
    states the composition in one place, mirrors `withReflection`, and can be tested with a
    scripted strategy.

## R2. Prompt format for history

- **Decision**: For a non-empty history:

  ```text
  Conversation so far (oldest first):
  User: <text>
  Assistant: <text>
  ...

  Current request: <message>
  ```

- **Rationale**: Plain labels are easy for the model to read and for tests to check. The
  "Current request" label keeps the model from answering an older question again.
- **Alternatives considered**: JSON transcript (harder for the model to read and noisier in the
  prompt); XML tags (fine, but no clear gain here).

## R3. Where the conversation tables live

- **Decision**: A new `SqliteConversationStore` opens its own `DatabaseSync` on the same path
  (`resolveDbPath`, which reads `OPSPILOT_DB`), with the same pragmas (`foreign_keys`,
  `busy_timeout`) and its own idempotent `CONVERSATION_SCHEMA`. `openConversationStore()` mirrors
  `openOpsStore()` and throws `StoreOpenError` on failure.
- **Rationale**: This matches the existing store style ("como no SqliteOpsStore") and keeps
  `OpsStore` focused on operations data. One file holds both, so backup and the `OPSPILOT_DB`
  setting stay unchanged (FR-011). Two connections to one file are safe with `busy_timeout`; with
  `":memory:"` each store gets its own private database, which is what tests want.
- **Alternatives considered**: Add the methods to `SqliteOpsStore` (mixes two concerns and grows
  the `OpsStore` contract that the MCP server and tools use); a separate database file (a second
  setting to configure for no benefit).

## R4. Message ordering

- **Decision**: `messages.id INTEGER PRIMARY KEY` (the rowid) sets the order. `lastMessages` reads
  the newest N with `ORDER BY id DESC LIMIT ?` in a subquery, then sorts those ascending. An index
  on `(conversation_id, id)` supports the query.
- **Rationale**: Timestamps can tie inside one millisecond; a rowid cannot. The fake store uses an
  array index, which gives the same order.

## R5. Conversation ids

- **Decision**: `crypto.randomUUID()`, generated inside `create()`. The store takes an optional
  `newId` and `now`, the same way `SqliteOpsStore` takes `now`, so tests stay deterministic. The
  request schema accepts `conversationId: z.uuid().optional()`.
- **Rationale**: Random UUIDs cannot be guessed (see the no-authentication assumption) and need no
  dependency. Validating the format means a malformed id is a 400 before any database work.

## R6. Unknown conversation id

- **Decision**: A new `ConversationNotFoundError extends Error` (not `DomainError`, because the model
  never sees it, like `UnknownStrategyError`). `lastMessages` and `append` throw it for an unknown
  id. The controller translates it into a 404 `conversation_not_found` reply.
- **Order of checks in the service**: (1) `createStrategy` (an unknown strategy is a 422 before
  anything is written), (2) load history or create the conversation, (3) run. So a 422 or a 404
  never creates a conversation.

## R7. Saving a turn

- **Decision**: A pure function `messagesToSave(message, outcome)` returns the two messages
  (`user`, then `assistant`) only when the run finished with `stopReason: "completed"`, and an empty
  list in every other case (FR-008, FR-009). The service appends what it returns, right after the
  run, with no `await` between the two calls.
- **Rationale**: `DatabaseSync` is synchronous, so two appends with no `await` between them cannot
  interleave with another request on the single Node thread. Only a process crash between the two
  calls could split a turn, which is acceptable for this project. This keeps the store at the three
  operations the user asked for (create, append, lastMessages).
- **Alternatives considered**: An `appendExchange` method that runs in one transaction. It is
  stronger, but it adds a fourth operation the user did not ask for. It is listed as a follow-up.
- **Timeout**: `runWithTimeout` resolves without waiting for an aborted run, and the service only
  saves when the outcome is `done`, so a run that finishes late saves nothing.

## R8. Where `historyMessages` lives

- **Decision**: It is added only at the HTTP boundary. `ChatOutcome` gains
  `conversation: { id: string; historyMessages: number }`, and `toHttpReply` merges
  `historyMessages` into `metrics` and puts `conversationId` on the 200, 502, and 504 bodies. The
  domain `Metrics` type does not change.
- **Rationale**: Strategies, the bench, and the arena do not know about conversations. Adding the
  field to domain `Metrics` would force every strategy and every metrics fixture to fill a value
  that means nothing to them.

## R9. The fake

- **Decision**: `src/testing/fake-conversation-store.ts` is a `Map`-backed `ConversationStore` with
  the same `newId` and `now` options. A shared `runConversationStoreContract(label, make)` (not a
  `*.test.ts` file, like `ops-store-contract.ts`) runs against both the fake and
  `SqliteConversationStore(":memory:")` (FR-013).
- **Rationale**: The service and HTTP tests use the fake so they do not need SQLite. The contract
  suite proves the fake behaves like the real store, so tests that pass on the fake can be trusted.
  The constitution allows in-memory stores only in tests, and `src/testing/` makes that clear.
