---

description: "Task list for feature 008: Semantic Memory"
---

# Tasks: Semantic Memory

**Input**: Design documents from `specs/008-semantic-memory/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. The feature input asks for a test that recall finds a fact sharing no word
with the query, and the constitution requires new logic to ship with a test. Within each story,
write the tests first and see them fail before you implement.

**Organization**: Tasks are grouped by user story, so each story can be built and tested on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1 to US4)
- Paths are relative to the repository root

---

## Phase 1: Setup

**Purpose**: A green baseline and the new dependency.

- [X] T001 Run `npm run typecheck` and `npm test` at the repository root and confirm both pass on the current `main`, so later failures can be traced to this feature
- [X] T002 Add `@huggingface/transformers` `^4.3.2` to `dependencies` in `package.json` with `npm install @huggingface/transformers@^4.3.2`. npm reports that the install scripts of `onnxruntime-node` and `protobufjs` were blocked: leave them blocked (research R10), do not change `allowScripts`. Re-run `npm run typecheck` to confirm the install broke nothing.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Domain types, the embedder seam and its fake, the vector helpers, and the table.
Every story depends on them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Add zod schemas and inferred types to `src/domain/schemas.ts` ([data-model.md](data-model.md)):
  - `UserId` = `z.string().trim().min(1).max(128)` ("trimmed, 1 to 128 characters")
  - `MemoryFact` = `z.string().trim().min(1).max(500)` ("trimmed, 1 to 500 characters")
  - `MemoryId` = `z.number().int().positive()` ("positive integer")
  - `Memory` = `{ id: MemoryId, userId: UserId, fact: MemoryFact, createdAt: string }` (`createdAt` is ISO 8601; no embedding field)
  - `RecalledMemory` = `Memory` + `{ score: number }` ("score in [-1, 1]")
  - `RememberResult` = `{ memory: Memory, created: boolean }`
- [X] T004 [P] Add `EmbeddingError extends Error` to `src/domain/errors.ts`. Its message is `Embedding failed: <reason>` and its `name` is `"EmbeddingError"`. It does NOT extend `DomainError`: the model must never see it, and it fails the request (research R8, R9).
- [X] T005 Create `src/memory/embeddings.ts` with only the pure parts for now:
  - `EMBEDDING_DIMENSIONS = 384`
  - `interface Embedder { embed(text: string): Promise<Float32Array> }`, with the JSDoc from [contracts/memory-store.md](contracts/memory-store.md) ("A unit-length vector of EMBEDDING_DIMENSIONS values. Throws EmbeddingError on failure.")
  - `dot(a, b)`: the sum of products. It throws a plain `Error` when the lengths differ.
- [X] T006 [P] Create `FakeEmbedder` in `src/testing/fake-embedder.ts`. It must never be wired into `src/index.ts`.
  - `unitVector(weights: Record<number, number>): Float32Array` builds a 384-value vector from axis → weight and normalizes it
  - The constructor takes `Record<string, Float32Array>` (text → vector), so a test can aim a score on purpose, for example 0.95 or 0.25
  - `embed` throws `EmbeddingError` for a text that is not in the table, so a test typo fails loudly
  - Option `{ failing: true }` makes every call throw `EmbeddingError`
  - A public `calls: string[]` records each text it embedded
- [X] T007 Create `src/memory/memory-store.ts` with the foundation:
  - `RECALL_LIMIT = 3`, `RECALL_MIN_SCORE = 0.3`, `DUPLICATE_THRESHOLD = 0.92`
  - `toBlob(vector): Uint8Array`, as `new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)`
  - `fromBlob(bytes): Float32Array`, which copies first (`new Float32Array(Uint8Array.from(bytes).buffer)`, research R5)
  - `scoreRows(vector, rows): RecalledMemory[]`, which drops the embedding ([contracts/memory-store.md](contracts/memory-store.md))
  - `MEMORY_SCHEMA`: the exact DDL from [data-model.md](data-model.md), with `CHECK (length(user_id) BETWEEN 1 AND 128)`, `CHECK (length(fact) BETWEEN 1 AND 500)`, `CHECK (length(embedding) = 1536)`, `STRICT`, and the `memories_by_user (user_id, id)` index
  - `interface MemoryStore` with `remember(userId, fact): Promise<RememberResult>` and `recall(userId, query): Promise<RecalledMemory[]>`. `forget` is added in US3 (T040).
- [X] T008 Add tests for `dot`, `toBlob`/`fromBlob`, and `scoreRows` in `src/memory/memory-store.test.ts`:
  - `dot` of `unitVector({0: 1})` with itself is 1, and two orthogonal axes give 0
  - `dot` throws on different lengths
  - `fromBlob(toBlob(v))` round-trips exactly, even when the input bytes sit at an odd `byteOffset` (slice a larger buffer at offset 1)
  - `toBlob` of a 384-value vector is 1536 bytes
- [X] T009 Create `runMemoryStoreContract(label, make)` in `src/memory/memory-store-contract.ts`. Model it on `src/store/conversation-store-contract.ts`; it is not a `*.test.ts` file. `make` takes `{ embedder: FakeEmbedder, now: () => string }`, and each test builds its own `FakeEmbedder` table. The cases are added story by story (T011, T029, T038).

**Checkpoint**: `npm run typecheck` and `npm test` are green.

---

## Phase 3: User Story 1 - The copilot remembers facts about the engineer by meaning (Priority: P1) 🎯 MVP

**Goal**: With a `userId`, `/chat` recalls up to 3 of that user's facts by meaning and puts them
ahead of the message. Without a `userId`, nothing changes.

**Independent Test**: Save a fact for a user with `remember`, recall with a query that shares no
word with it, and get the fact back with a score of at least 0.3 (real model). Over HTTP, a
seeded fake store makes the scripted model receive the facts block, and
`metrics.recalledMemories` is 1.

### Tests for User Story 1 (write first, see them fail)

- [X] T010 [P] [US1] Add `rankMemories` tests in `src/memory/memory-store.test.ts`, using `RecalledMemory` literals with chosen scores:
  - `0.3` is kept and `0.2999` is dropped (FR-005, "at least 0.3")
  - 5 matches give 3, best first
  - equal scores come back with the higher id first ("newest first on a tie")
  - an empty input gives `[]`
- [X] T011 [P] [US1] Add contract cases 1, 5, 6, 7, 8, 9, 12, and 13 from [contracts/memory-store.md](contracts/memory-store.md) to `src/memory/memory-store-contract.ts`:
  - 1: `remember` returns `created: true`, with a positive id, the user, the trimmed fact, and `createdAt` from `now`
  - 5: at most 3, best first, each with its score
  - 6: a fact scoring 0.25 is left out and one scoring 0.35 is kept
  - 7: equal scores come back newest first
  - 8: a user with no memories gets `[]`
  - 9: another user's memories are never returned
  - 12: an empty fact, a whitespace-only fact, and a fact of 501 characters are rejected, and nothing is stored
  - 13: `x'); DROP TABLE memories;--` is stored and returned verbatim
- [X] T012 [P] [US1] Write `src/agents/memories.test.ts`:
  - `composeMemoryInput([], input)` returns `input` unchanged
  - with two memories it returns exactly `Facts remembered about this engineer (best match first; they may be out of date):\n- [memory 7] <fact>\n- [memory 3] <fact>\n\n<input>` (research R7)
  - `withMemories` keeps the strategy `name` and passes the composed input and the same options
  - `withHistory(withMemories(s, m), h)` gives the facts block first, then `Conversation so far`, then `Current request:`
- [X] T013 [P] [US1] Extend `src/http/schemas.test.ts`:
  - `ChatRequest` accepts a missing `userId`, trims `" oncall-a "`, and rejects `""`, `"   "`, a 129-character string, and a number
  - `MetricsSchema` requires `recalledMemories` (a non-negative integer)
- [X] T014 [P] [US1] Extend `src/http/chat-reply.test.ts` so that `toHttpReply` puts `recalledMemories` from `ChatOutcome` in the 200 metrics and in the 502 partial metrics
- [X] T015 [US1] Extend `src/http/chat-service.test.ts` (and `src/http/server.test.ts` where the HTTP status matters), using `FakeMemoryStore`, `FakeEmbedder`, and the scripted chat model:
  - with a `userId` and one seeded matching fact, the strategy input starts with the facts block, and `recalledMemories` is 1
  - without a `userId`, the embedder is never called, the input is exactly as before, and `recalledMemories` is 0 (FR-013)
  - an unknown `conversationId` gives a 404 before any embedding (`embedder.calls` is empty)
  - with a failing embedder: 500 `internal`, the controller logs `Memory recall failed: …`, no conversation is created, and the agent does not run
  - a memory remembered during the run is not in the facts block of that same run
- [X] T016 [P] [US1] Write `src/memory/embeddings.test.ts`:
  - *Loader tests, with a fake load function, no model*: two `embed` calls before the load resolves trigger one load; after a rejected load the next call loads again; a vector that is not 384 long becomes `EmbeddingError`
  - *Real-model `describe`, timeout 300 000 ms, skipped with a printed reason when `OPSPILOT_SKIP_MODEL_TESTS=1`*:
    - `localEmbedder` returns 384 values of unit length (within 1e-4)
    - with a `SqliteMemoryStore` on `":memory:"`, "who should I page about failed purchases?" recalls "The payments team owns the checkout service" and not "my favourite colour is green" (SC-001)
    - "keep replies brief, please" recalls "I prefer answers in short bullet lists" first
    - the test asserts only the side of the threshold, never an exact score (research R4)

### Implementation for User Story 1

- [X] T017 [US1] Implement `rankMemories(scored, { limit, minScore })` in `src/memory/memory-store.ts`, as the one `TODO(human)` of this feature (see Learn by Doing). T010 states the expected behaviour.
- [X] T018 [US1] Implement `SqliteMemoryStore(path, { embedder, now? })` in `src/memory/memory-store.ts`:
  - The constructor runs `PRAGMA busy_timeout = 5000` and `MEMORY_SCHEMA`, prepares the insert and the select-by-user statements from [data-model.md](data-model.md), and closes the database if setup throws
  - `remember`: parse `UserId` and `MemoryFact`, embed the trimmed fact, insert `toBlob(vector)`, and return `{ memory, created: true }`. Dedup comes in T032.
  - `recall`: parse `UserId`, embed the query, select the user's rows, `fromBlob`, `scoreRows`, then `rankMemories` with `RECALL_LIMIT` and `RECALL_MIN_SCORE`
  - Parse every row with a zod row schema, so a hand-edited row fails loudly
  - Add `close()` and `openMemoryStore(env, { embedder, now? })`: reuse `resolveDbPath` and create the directory, and wrap failures in `StoreOpenError`, as `openConversationStore` does
- [X] T019 [P] [US1] Create `FakeMemoryStore({ embedder, now? })` in `src/testing/fake-memory-store.ts`. It is array-backed with increasing ids, reuses `scoreRows` and `rankMemories`, and must never be wired into `src/index.ts`.
- [X] T020 [US1] Run the contract on both stores: `src/memory/memory-store.test.ts` calls `runMemoryStoreContract("sqlite :memory:", …)`, and the new `src/testing/fake-memory-store.test.ts` calls `runMemoryStoreContract("fake", …)`
- [X] T021 [US1] Finish `src/memory/embeddings.ts` (research R1, R2):
  - `createLazyEmbedder(load)` keeps one cached `Promise` of the extractor, clears it when it rejects, wraps every failure in `EmbeddingError`, and checks that the result has `EMBEDDING_DIMENSIONS` values
  - `embed` calls the extractor with `{ pooling: "mean", normalize: true }` and returns `output.data` as a `Float32Array`
  - `localEmbedder = createLazyEmbedder(() => pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" }))`, and importing the module does not load the model
- [X] T022 [P] [US1] Create `src/agents/memories.ts` with the pure `composeMemoryInput(memories, input)` and the `withMemories(strategy, memories)` decorator, in the format of research R7 and in the same style as `src/agents/history.ts`
- [X] T023 [P] [US1] In `src/http/schemas.ts`, add `userId: UserId.optional()` to `ChatRequest` and `recalledMemories: Count` to `MetricsSchema`. Its JSDoc says it is HTTP-only, like `historyMessages`.
- [X] T024 [US1] In `src/http/chat-reply.ts`, add `recalledMemories: number` to `ChatOutcome`, and put it in the 200 metrics and in the `runFailed` partial metrics
- [X] T025 [US1] Wire the service and the controller:
  - `src/http/server.ts`: add the required `memories: MemoryStore` to `AppSettings`
  - `src/http/chat-service.ts`: reorder `runChat` as in research R9. Strategy (422), then `lastMessages` when there is a `conversationId` (404), then `recall` when there is a `userId`, then `create()` when there is no `conversationId`, then run `withHistory(withMemories(strategy, recalled), history)`, then save, then return `recalledMemories: recalled.length`.
  - `src/http/chat-controller.ts`: on `EmbeddingError`, `console.error("Memory recall failed: " + message)` and re-throw to the 500 handler
- [X] T026 [US1] Pass `memories: new FakeMemoryStore(...)` in every existing `createApp` and `runChat` call in `src/http/*.test.ts`. This must land together with T025, or the HTTP tests stop compiling.
- [X] T027 [US1] In `src/index.ts`, open `openMemoryStore(process.env, { embedder: localEmbedder })` next to `openConversationStore()`, inside the same `StoreOpenError` handling, and pass it as `memories`

**Checkpoint**: US1 works on its own. Facts saved with the store's `remember` are recalled by
meaning over `/chat`.

---

## Phase 4: User Story 2 - Saving a fact does not pile up near-duplicates (Priority: P2)

**Goal**: `remember` returns the existing memory when a new fact scores above 0.92, and the agent
can save facts through `remember_fact`, bound to the request's `userId`.

**Independent Test**: Remember a fact, then a near-identical rewording for the same user. The
second call returns the first memory with `created: false`, and the user still has one memory.

### Tests for User Story 2 (write first, see them fail)

- [X] T028 [P] [US2] Add `findDuplicate` tests in `src/memory/memory-store.test.ts`, using literals:
  - `0.92` is not a duplicate and `0.9200001` is ("above 0.92")
  - with several above the threshold, the highest is returned
  - an empty input gives `undefined`
- [X] T029 [P] [US2] Add contract cases 2, 3, and 4 to `src/memory/memory-store-contract.ts`:
  - 2: a text scoring 0.95 against an existing fact returns that memory with `created: false`, and recall shows one memory
  - 3: a text scoring 0.9 stores a second memory
  - 4: the same fact for two users is stored twice
- [X] T030 [P] [US2] Write `src/agents/memory-tools.test.ts` for `remember_fact`:
  - the tool schema has no user id key
  - invoking it stores the fact under the bound `userId` and returns JSON `{ id, fact, created }`
  - a duplicate returns `created: false`
  - a second tool set bound to another user never sees the first user's facts
- [X] T031 [US2] Extend `src/http/chat-service.test.ts`:
  - the tools given to the strategy include `remember_fact` only when the request has a `userId`
  - a scripted run that calls `remember_fact` with `{ fact: "" }` keeps going, the model receives an error tool message, and the run completes (FR-019)

### Implementation for User Story 2

- [X] T032 [US2] Add the pure `findDuplicate(scored, threshold)` to `src/memory/memory-store.ts`, and use it in `remember` in both `SqliteMemoryStore` and `src/testing/fake-memory-store.ts`. Embed first, then select, score, check for a duplicate, and insert with no `await` between them (research R6).
- [X] T033 [P] [US2] Add `runToolTextAsync(action: () => Promise<unknown>): Promise<ToolOutcome>` to `src/tools/definitions.ts`, with the same rule as `runToolText`: a `DomainError` becomes `Error: …` text, and anything else re-throws
- [X] T034 [P] [US2] Create `src/tools/memory-definitions.ts` with `rememberFactDefinition`: the name `remember_fact`, the description from [contracts/memory-tools.md](contracts/memory-tools.md), the schema `z.object({ fact: MemoryFact })`, and `run(memories, userId, input)`. Do not add it to `TOOL_DEFINITIONS`.
- [X] T035 [US2] Create `createMemoryTools(memories, userId)` in `src/agents/memory-tools.ts`. It returns LangChain `tool(...)` wrappers that call `runToolTextAsync`, with `userId` captured in the closure.
- [X] T036 [US2] In `src/http/chat-service.ts`, when `request.userId` is set, append `createMemoryTools(settings.memories, userId)` to `createDependencies().tools` before `createStrategy`
- [X] T037 [US2] Make T031's invalid-input case pass. If the agent's tool node re-throws schema errors instead of returning them to the model, switch the tool's LangChain schema to a loose `z.object({ fact: z.string() })`, validate with `MemoryFact.safeParse` inside the handler, and return `Error: …` (research R8)

**Checkpoint**: The agent saves facts, and rewordings above 0.92 do not pile up.

---

## Phase 5: User Story 3 - The engineer can remove a fact that is wrong or outdated (Priority: P3)

**Goal**: `forget` removes one of the user's facts by id, and the agent can do it through
`forget_fact`.

**Independent Test**: Remember a fact, forget it by its id, and check that recall no longer
returns it. Forgetting another user's id throws `MemoryNotFoundError` and removes nothing.

### Tests for User Story 3 (write first, see them fail)

- [X] T038 [P] [US3] Add contract cases 10 and 11 to `src/memory/memory-store-contract.ts`:
  - 10: after `forget`, recall no longer returns the fact
  - 11: an unknown id, and another user's id, throw `MemoryNotFoundError` carrying `memoryId`, and every memory stays
- [X] T039 [P] [US3] Extend `src/agents/memory-tools.test.ts` for `forget_fact`:
  - it returns `{ id, forgotten: true }`
  - an unknown id returns the text `Error: Memory not found: <id>`
  - the schema has no user id key

### Implementation for User Story 3

- [X] T040 [US3] Add `MemoryNotFoundError extends DomainError` to `src/domain/errors.ts`, with a readonly `memoryId: number`, the message `Memory not found: <id>`, and the `name` `"MemoryNotFoundError"`. Add `forget(userId, id): void` to the `MemoryStore` interface in `src/memory/memory-store.ts`.
- [X] T041 [US3] Implement `forget` in `SqliteMemoryStore`, with the prepared statement `DELETE FROM memories WHERE id = ? AND user_id = ?` that throws `MemoryNotFoundError` when `changes !== 1`, and in `src/testing/fake-memory-store.ts`
- [X] T042 [US3] Add `forgetFactDefinition` (the name `forget_fact`, the schema `z.object({ id: MemoryId })`, and the description from [contracts/memory-tools.md](contracts/memory-tools.md)) to `src/tools/memory-definitions.ts`, and add it to `createMemoryTools` in `src/agents/memory-tools.ts`

**Checkpoint**: Facts can be saved, recalled, and removed, scoped to one user.

---

## Phase 6: User Story 4 - Memories survive a restart (Priority: P3)

**Goal**: The `memories` table is durable and its CHECKs guard bad rows.

**Independent Test**: Remember a fact in a store on a temp file, close it, reopen it, and get the
same memory back with the same score.

- [X] T043 [P] [US4] In `src/memory/memory-store.test.ts`, add a restart test:
  - `mkdtemp` under `os.tmpdir()`, remember two facts, `close()`, open a new `SqliteMemoryStore` on the same file, and recall them with the same ids and scores
  - opening the store twice is safe (idempotent DDL)
  - remove the directory in `after`
- [X] T044 [P] [US4] In `src/memory/memory-store.test.ts`, add CHECK tests that insert with raw prepared SQL on `":memory:"`:
  - a 1535-byte embedding, an empty `user_id`, a 129-character `user_id`, and a 501-character fact are each rejected
  - a parity test asserts that the `BETWEEN` limits in `MEMORY_SCHEMA` match the `UserId` and `MemoryFact` limits

**Checkpoint**: Every story is done.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T045 [P] Add a "Semantic memory" section to `README.md`: the `userId` field, `metrics.recalledMemories`, the `remember_fact` and `forget_fact` tools, the 90 MB model download on first use, and `OPSPILOT_SKIP_MODEL_TESTS=1`, with the two-call example from [quickstart.md](quickstart.md)
- [X] T046 [P] Confirm that `TOOL_DEFINITIONS`, the MCP server (`src/mcp/`), `src/arena.ts`, and `src/bench.ts` are unchanged and still compile. They run without memory.
- [ ] T047 Run `npm run typecheck` and `npm test`, and both must be green with the real-model test running, not skipped. Then run quickstart steps 2 to 4 by hand against a scratch `OPSPILOT_DB` path.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: depends on Setup and blocks every story
- **US1 (Phase 3)**: depends on Foundational. It includes the `src/index.ts` wiring, because `AppSettings.memories` becomes required.
- **US2 (Phase 4)**: depends on US1 (T018, T019, and T025), because dedup lives in `remember` and the tools go through `runChat`
- **US3 (Phase 5)**: depends on US1. Its tool part (T042) depends on US2 (T034 and T035).
- **US4 (Phase 6)**: depends on US1 (T018) only, and can run alongside US2 and US3
- **Polish (Phase 7)**: after every story you want to ship

### Within Phases

- In Phase 2, T003 and T004 come before T005. T005 comes before T006 and T007. T007 comes before T008 and T009.
- In US1, write the tests T010 to T016 first, and they should fail. Then implement:
  - T017, then T018 and T019, then T020
  - T021 and T022 in any order
  - T023, then T024, then T025 together with T026, then T027
- T026 must land in the same change as T025
- In US2, T032 comes before T035 and T036, and T033 and T034 come before T035

### Parallel Opportunities

- Phase 2: T003 and T004 together; after T005, T006 and T007 together
- US1 tests: T010 to T014 and T016 together (different files)
- US1 implementation: T019, T022, and T023 alongside T018
- US2: T028 to T030 together; T033 and T034 together
- US4 (T043 and T044) can run while US2 or US3 is in progress, once T018 is done
- Polish: T045 and T046 together

### Parallel Example: User Story 1

```text
Task: "T010 rankMemories boundary tests in src/memory/memory-store.test.ts"
Task: "T012 composeMemoryInput / withMemories tests in src/agents/memories.test.ts"
Task: "T013 ChatRequest.userId / MetricsSchema.recalledMemories tests in src/http/schemas.test.ts"
Task: "T016 lazy loader and real-model tests in src/memory/embeddings.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1, then Phase 2
2. Phase 3 (US1): recall by meaning over `/chat`, with the real-model proof (SC-001)
3. **Stop and validate**: `npm test` with the real-model test running, then quickstart step 2,
   seeding the fact with a short script that calls `remember` (the tools come in US2)

### Incremental Delivery

1. US1: recall by meaning (MVP)
2. US2: dedup, and the agent saves facts by itself
3. US3: forget
4. US4: the restart and CHECK guarantees, under test
5. Polish: the docs and the final green run

### Learn by Doing

- T017 leaves `rankMemories` in `src/memory/memory-store.ts` as the only `TODO(human)`. T010
  already pins its behaviour: the `>=` at 0.3, best first, newest first on a tie, and the cut at 3.

## Notes

- `[P]` means a different file with no dependency on an unfinished task
- Every query uses a prepared statement. Tests use only `":memory:"` or a fresh `mkdtemp`
  directory, and never `OPSPILOT_DB` or `data/`.
- Only `src/memory/embeddings.test.ts` loads the real model. Every other test uses `FakeEmbedder`.
- Never read `.env`
