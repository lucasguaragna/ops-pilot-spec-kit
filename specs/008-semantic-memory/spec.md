# Feature Specification: Semantic Memory

**Feature Branch**: `008-semantic-memory`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "Semantic memory: a MemoryStore per userId with remember (dedup above
0.92), recall of the top 3 by dot product (minimum 0.3), and forget; a memories table with the
columns id, user_id, fact, embedding, created_at; embeddings from all-MiniLM-L6-v2 run locally and
stored as a BLOB. /chat takes a userId and injects the recall into the prompt. Test: recall finds a
fact that shares no word with the query. Use @huggingface/transformers with pooling mean and
normalize true, as a lazy singleton, in src/memory/embeddings.ts and src/memory/memory-store.ts."
The original Portuguese text is in `docs/prompts/0116-20261120-155944.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The copilot remembers facts about the engineer by meaning (Priority: P1)

An on-call engineer has told OpsPilot, at some point in the past, that "the payments team owns the
checkout service". Days later, in a brand-new conversation, they ask "who should I page about
failed purchases?". The question shares no word with the stored fact, but it means something close
to it, so the copilot gets that fact as context and can answer with it.

**Why this priority**: Conversation history (feature 007) only covers one thread. Long-lived facts
about the engineer's world (ownership, preferences, runbook quirks) must reach the copilot in any
conversation, and engineers rarely phrase a question with the same words they used to state a fact.
Matching by meaning, not by keywords, is the core value of this feature.

**Independent Test**: Save a fact for a user, then recall with a query that shares no word with the
fact, and check that the fact comes back with a score of at least 0.3.

**Acceptance Scenarios**:

1. **Given** a user with a saved fact, **When** that user sends a chat message whose meaning is
   close to the fact but shares no word with it, **Then** the agent receives that fact as context
   ahead of the message.
2. **Given** a user with more than 3 facts that match the message, **When** the user sends the
   message, **Then** the agent receives only the 3 best matches, best first.
3. **Given** a user whose facts all score below 0.3 against the message, **When** the user sends
   the message, **Then** the agent receives no facts and the run behaves as it does today.
4. **Given** a chat request with no user id, **When** it is sent, **Then** no facts are recalled
   and the run behaves exactly as it does today.

---

### User Story 2 - Saving a fact does not pile up near-duplicates (Priority: P2)

The engineer states the same fact several times in slightly different words ("the payments team
owns the checkout service", "the payments team is responsible for the checkout service"). The
memory keeps one copy, so recall is not crowded by repeats of the same fact and the three slots go
to different facts. A shorter or looser rewording ("payments owns checkout") is close but below the
duplicate threshold, so it is kept as its own fact.

**Why this priority**: Without deduplication the top 3 fill up with copies of one fact, which
hides the other relevant facts and wastes context.

**Independent Test**: Save a fact, save a near-identical rewording of it for the same user, and
check that the user still has one memory and that the second save reports the existing one.

**Acceptance Scenarios**:

1. **Given** a user with a saved fact, **When** a new fact is saved whose similarity to it is
   above 0.92, **Then** no new memory is stored and the result names the existing memory.
2. **Given** a user with a saved fact, **When** a new fact is saved whose similarity to every
   existing fact is 0.92 or less, **Then** a new memory is stored.
3. **Given** two different users, **When** both save the same fact, **Then** each user has their
   own copy; deduplication never crosses users.
4. **Given** a chat request with a user id, **When** the engineer states a lasting fact and the
   agent calls the save tool, **Then** the fact is stored for that user and recalled in a later
   request.

---

### User Story 3 - The engineer can remove a fact that is wrong or outdated (Priority: P3)

Team ownership changes. The engineer removes the outdated fact so the copilot stops using it.

**Why this priority**: A memory that can only grow eventually feeds the copilot stale facts during
an incident. Forgetting is needed, but less often than remembering and recalling.

**Independent Test**: Save a fact, forget it by its id, and check that recall no longer returns it.

**Acceptance Scenarios**:

1. **Given** a user with a saved fact, **When** the user forgets it by its id, **Then** recall
   never returns it again and the operation reports that a memory was removed.
2. **Given** a memory that belongs to another user, **When** a user tries to forget it, **Then**
   nothing is removed and the operation reports that no memory was found.

---

### User Story 4 - Memories survive a restart (Priority: P3)

Facts saved before a deploy are still recalled after the service restarts.

**Why this priority**: Long-lived facts are the whole point of this memory; losing them on restart
would make it no better than conversation history.

**Independent Test**: Save a fact in a store backed by a database file, close it, open a new store
on the same file, and recall the fact.

**Acceptance Scenarios**:

1. **Given** a saved fact, **When** the service restarts, **Then** recall for that user still
   returns the fact with the same score as before.

---

### Edge Cases

- A user with no memories gets an empty recall; the chat run is unchanged.
- An empty or whitespace-only fact is rejected; nothing is stored.
- An empty or malformed user id in a chat request is rejected as an invalid request body.
- Forgetting an id that does not exist, or that belongs to another user, removes nothing and
  reports "not found"; it never touches another user's memories.
- A similarity of exactly 0.92 is not a duplicate (the rule is "above 0.92"); a score of exactly
  0.3 is recalled (the rule is "at least 0.3").
- Two facts with the same score are ordered newest first.
- The first request after a start pays the one-time cost of loading the embedding model; later
  requests reuse the loaded model.
- If the embedding model cannot be loaded or fails on a message, the chat request fails with an
  internal error instead of answering without the user's memories, so a missing memory is never
  silent.
- A chat request with no user id offers no memory tools, so the agent cannot save a fact that would
  belong to nobody.
- A fact saved by the agent during a run is available to recall from the next request on; it does
  not change the facts already recalled for the current run.
- A user id and a conversation id are independent: the same user's memories are recalled in every
  conversation, and a conversation can be continued with or without a user id.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The memory MUST keep facts per user. Every operation MUST be scoped to one user id
  and MUST NOT read, change, or remove another user's facts.
- **FR-002**: The memory MUST offer three operations: remember a fact, recall the facts that best
  match a query, and forget a fact by its id.
- **FR-003**: Remember MUST compute the fact's meaning fingerprint (embedding) once, when the fact
  is saved, and store it with the fact.
- **FR-004**: Remember MUST NOT store a new fact when its similarity to an existing fact of the
  same user is above 0.92; it MUST report the existing memory instead. Otherwise it MUST store the
  fact and report the new memory.
- **FR-005**: Recall MUST score every fact of the user against the query by the dot product of
  their normalized embeddings, keep only facts scoring at least 0.3, and return at most 3, highest
  score first (newest first on a tie), each with its score.
- **FR-006**: Recall MUST match by meaning: a fact that shares no word with the query MUST still be
  returned when its score is at least 0.3.
- **FR-007**: Forget MUST remove the user's fact with the given id and report whether a fact was
  removed.
- **FR-008**: Embeddings MUST be computed locally, with no call to an external service at request
  time, and the model MUST be loaded once per process, on first use, and then reused.
- **FR-009**: The chat request MUST accept an optional user id.
- **FR-010**: When the chat request has a user id, the system MUST recall facts for that user using
  the engineer's message as the query, and MUST give the recalled facts to the agent ahead of the
  message.
- **FR-011**: Recalled facts MUST reach the agent through the existing prompt-building path, so
  every strategy (with or without reflection) and every conversation receives them without
  strategy-specific code.
- **FR-012**: Every chat reply that carries metrics MUST report `recalledMemories`: the number of
  facts given to the agent (0 to 3).
- **FR-013**: A chat request with no user id MUST behave exactly as it does today, with
  `recalledMemories` equal to 0.
- **FR-014**: Memories MUST persist across restarts, in the same database as the operations data.
- **FR-015**: The memory storage MUST have a durable implementation and a test double that follow
  the same contract, and both MUST pass the same contract tests.
- **FR-016**: Remember and forget MUST be reachable from a chat as two agent tools: one that saves
  a fact and one that forgets a fact by its id. The agent decides when to call them, for example
  when the engineer states a lasting fact or says a fact is no longer true.
- **FR-017**: The two memory tools MUST be offered to the agent only when the chat request has a
  user id, and MUST always act on that user id. The agent MUST NOT be able to choose or change the
  user a tool acts on.
- **FR-018**: Recalled facts given to the agent MUST include each memory's id, so the agent can
  name the fact to forget.
- **FR-019**: The tool inputs MUST be validated like every other tool input; an invalid fact or id
  MUST come back to the agent as a tool error, not fail the run.

### Key Entities

- **Memory**: One fact about a user's world. Has an opaque, server-generated id, the user it
  belongs to, the fact text, the fact's embedding, and a creation time.
- **Recalled memory**: A memory returned by recall, together with its similarity score against
  the query. It exists only for the duration of one request and is never stored.
- **User**: Identified only by the user id the client sends. There is no user record; a user exists
  as soon as one of their facts is stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fact that shares no word with the question is recalled for that question when the
  two mean nearly the same thing (verified by an automated test on at least one such pair).
- **SC-002**: The agent never receives more than 3 recalled facts per request, whatever the number
  of stored facts.
- **SC-003**: Saving a rewording of an existing fact (similarity above 0.92) never increases the
  user's number of stored facts.
- **SC-004**: In 100% of requests, recall and forget for one user never return or remove another
  user's facts.
- **SC-005**: After a restart, 100% of stored facts are still recalled with the same scores.
- **SC-006**: Only the first request after a start waits for the model to load; later requests add
  no load time.
- **SC-007**: Every existing chat flow (no user id sent) keeps working, with the only visible change
  being the new `recalledMemories` metric.

## Assumptions

- There is no authentication. The user id is any non-empty string the client sends (trimmed, at
  most 128 characters), the same trust level as the conversation id in feature 007.
- A fact is non-empty after trimming and at most 500 characters, which fits the embedding model's
  input window for one sentence or a short paragraph.
- The thresholds (0.92 for deduplication, 0.3 for recall) and the limit of 3 are fixed settings,
  not request parameters.
- Recall scans all facts of one user and scores them in the process. This is fine for the expected
  size (tens to hundreds of facts per user) and needs no vector index.
- The engineer's message alone is the recall query; the conversation history is not part of it.
- Memories have no retention limit and there is no way to list a user's memories in this feature.
- Remember and forget are reached only through the agent tools; there are no HTTP endpoints for
  memories in this feature (decided during specification, 2026-11-20).
- Technical constraints from the request, to be honored by the plan: embeddings come from
  `all-MiniLM-L6-v2` through `@huggingface/transformers`, with mean pooling and normalization (so
  the dot product equals cosine similarity); the model loader is a lazy singleton in
  `src/memory/embeddings.ts`; the store lives in `src/memory/memory-store.ts`; the table is
  `memories` with columns `id`, `user_id`, `fact`, `embedding` (BLOB), `created_at`.
- The model files are downloaded once on first use and cached on disk; after that the model runs
  fully offline. The semantic test (SC-001) uses the real model, so it needs that one download;
  every other test uses a deterministic fake embedder.
- Adding the embedding library is a new dependency, not a stack replacement, so it needs no
  constitution amendment.
- The MCP server and the arena/bench commands are out of scope; they keep running without memory.
- Tests use an in-memory database and a fake store; they never touch the real database file.
