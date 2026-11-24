# Feature Specification: Learning Reflector

**Feature Branch**: `009-learning-reflector`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Learning reflector: after each reply, a withStructuredOutput({hasLearning,
fact}) call reads the user's last message and distils durable facts (never a one-off request, never
a secret) into memories.remember, asynchronously; a forget_preference tool." The original Portuguese
text is in `docs/prompts/0120-20261124-131826.md`.

## Clarifications

### Session 2026-11-24

- Q: How does `forget_preference` relate to the existing `forget_fact` (which removes by id)? → A:
  `forget_preference` removes by description: it takes a short text, finds the user's closest
  memory, and removes it when the match is close enough. `forget_fact` stays as it is.
- Q: Does `remember_fact` stay now that the reflector saves facts on its own? → A: Yes. An explicit
  "remember that X" is saved during the run by the tool; the reflector catches facts the engineer
  only implied. Deduplication (above 0.92) keeps the two paths from storing the same fact twice.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The copilot learns lasting facts without being told to remember them (Priority: P1)

An on-call engineer writes "I'm on the payments team, so checkout alerts are mine. Which ones are
firing?". They never say "remember". OpsPilot answers the question, and afterwards, without making
the engineer wait, it notices that the message contains a lasting fact ("the engineer is on the
payments team and owns checkout alerts") and saves it to that engineer's memory. In a later
conversation the fact is recalled like any other memory.

**Why this priority**: Engineers rarely ask a copilot to remember things; they mention them in
passing. With feature 008 a fact is saved only when the agent decides to call the save tool in the
middle of a run, which it often does not. A dedicated step that looks at every message for lasting
facts is the core value of this feature.

**Independent Test**: Send a chat request with a user id whose message states a lasting fact and
asks a question, wait for the background step to finish, and check that the user now has one memory
holding that fact, while the reply itself was returned unchanged.

**Acceptance Scenarios**:

1. **Given** a chat request with a user id whose message states a lasting fact, **When** the run
   completes with an answer, **Then** the reply is sent without waiting for the learning step, and
   the fact is then saved for that user.
2. **Given** a fact learned from an earlier request, **When** the same user asks a related question
   in a new conversation, **Then** the fact is recalled and given to the agent.
3. **Given** a message whose lasting fact is already saved for the user, or is a close rewording of
   one (similarity above 0.92), **When** the learning step runs, **Then** no new memory is stored.
4. **Given** a chat request with no user id, **When** the run completes, **Then** no learning step
   runs and nothing is saved.

---

### User Story 2 - One-off requests and secrets are never learned (Priority: P1)

Most messages are requests for the moment: "open an incident for checkout", "resolve INC-004",
"which alerts are firing?". Some contain secrets: "the staging DB password is hunter2". None of these
is a fact worth keeping, and a secret must never be stored. The learning step saves nothing for them.

**Why this priority**: A memory that fills with one-off requests crowds out useful facts at recall
time, and a stored secret is a security incident: memories are given back to the model in every
later conversation. This guard is as important as the learning itself.

**Independent Test**: Run the learning step on a set of one-off requests and on messages that
contain a password, token, or key, and check that no memory is stored for any of them.

**Acceptance Scenarios**:

1. **Given** a message that is only a request for the current moment, **When** the learning step
   runs, **Then** it reports no learning and nothing is saved.
2. **Given** a message that contains a secret (password, API key, token, private key, connection
   string with credentials), **When** the learning step runs, **Then** no fact holding that secret
   is saved, even if the model proposes one.
3. **Given** a message that mixes a lasting fact and a secret ("I own checkout; the DB password is
   hunter2"), **When** the learning step runs, **Then** at most the lasting fact is saved, without
   the secret.

---

### User Story 3 - The engineer can make the copilot forget a preference by describing it (Priority: P2)

The engineer writes "forget that I like bullet lists". They do not know the memory id. The agent
calls `forget_preference` with a short description of the fact; the closest memory of that engineer
is removed if it matches closely enough, and the agent can tell the engineer which fact was removed.

**Why this priority**: The learning step saves facts silently, so the engineer never sees their
ids. Forgetting by id (`forget_fact`) only works for facts recalled in the current request.
Forgetting by description closes that gap. It is needed less often than learning, hence P2.

**Independent Test**: Save a fact for a user, call the forget-by-description tool with a rewording
of it, and check that the fact is removed and named in the tool result; call it again with an
unrelated description and check that nothing is removed.

**Acceptance Scenarios**:

1. **Given** a user with a saved fact, **When** the agent calls `forget_preference` with a
   description whose similarity to that fact is at least 0.5, **Then** that one fact is removed and
   the result names it.
2. **Given** a user whose facts all score below 0.5 against the description, **When** the agent
   calls `forget_preference`, **Then** nothing is removed and the result says no matching fact was
   found.
3. **Given** two users with the same fact, **When** one user's request calls `forget_preference`,
   **Then** only that user's fact is removed.
4. **Given** several facts that match the description, **When** the tool is called, **Then** only
   the single closest one is removed (newest first on a tie).

---

### Edge Cases

- The run ends without an answer (iteration limit, error, timeout): the learning step does not run,
  so a retried request is not learned twice.
- The learning step fails (model error, invalid structured answer, store or embedding failure, or it
  takes too long): the failure is logged and nothing is saved. The reply already sent is never
  affected.
- The model reports a learning but gives an empty, blank, or over-long fact (more than 500
  characters after trimming): nothing is saved and the problem is logged.
- The model reports no learning but still returns a fact text: the fact is ignored.
- A message with several lasting facts: the learning step saves at most one fact per message in this
  feature.
- The agent already saved the same fact during the run with `remember_fact`: the learning step's
  save is a near-duplicate and stores nothing new, or stores a reworded copy only if its similarity
  is 0.92 or less.
- Two requests from the same user in quick succession: the second request may not yet see the fact
  learned from the first, because the learning step finishes after the first reply. The fact is
  available from the next request after it is saved.
- The process stops while a learning step is still running: that one fact may be lost. Nothing else
  is affected.
- A correction such as "no, that's wrong" relies on the earlier messages; the learning step sees
  only the last message, so it learns nothing from it.
- `forget_preference` with an empty description is a tool input error that goes back to the agent;
  the run continues.
- A chat request with no user id offers neither `forget_preference` nor the other memory tools.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: After a chat run with a user id completes with an answer, the system MUST run a
  learning step that reads only the engineer's last message (the message of that request).
- **FR-002**: The learning step MUST NOT run for a request with no user id, or for a run that ends
  without an answer (iteration limit, error, or timeout).
- **FR-003**: The learning step MUST ask the model for a structured answer with exactly two parts:
  whether the message holds a lasting fact (`hasLearning`), and that fact (`fact`) as one short,
  self-contained sentence.
- **FR-004**: The learning step MUST treat as lasting only facts that stay true beyond the current
  request, such as ownership, team membership, preferences, and quirks of the engineer's systems. It
  MUST NOT learn one-off requests, questions, or the current state of an alert or incident.
- **FR-005**: The learning step MUST NOT save a secret. The model MUST be told never to put
  credentials in a fact, and every proposed fact MUST also pass a deterministic check that rejects
  text that looks like a password, API key, token, private key, or credentialed connection string,
  whatever the model answered.
- **FR-006**: When the answer says there is a learning and the fact passes validation (non-empty
  after trimming, at most 500 characters) and the secret check, the system MUST save it through the
  existing memory for that user, so the existing deduplication (above 0.92) applies.
- **FR-007**: The chat reply MUST NOT wait for the learning step. The reply's status, body, and
  metrics MUST be the same as without this feature.
- **FR-008**: A failure or timeout of the learning step MUST be logged and MUST NOT affect the reply,
  the conversation history, or other requests. The learning step MUST give up after a bounded time.
- **FR-009**: The learning step MUST save at most one fact per message.
- **FR-010**: The agent MUST get a `forget_preference` tool, only when the chat request has a user
  id, bound to that user id like the other memory tools; the agent MUST NOT be able to choose the
  user.
- **FR-011**: `forget_preference` MUST take a short description, find the user's single closest
  memory by meaning, and remove it only when its similarity to the description is at least 0.5
  (newest first on a tie). It MUST return the removed fact and its id, or say that no matching fact
  was found and remove nothing.
- **FR-012**: `forget_preference` input MUST be validated like every other tool input; an invalid
  description MUST come back to the agent as a tool error, not fail the run.
- **FR-013**: `remember_fact` and `forget_fact` MUST keep working as in feature 008.
- **FR-014**: The learning step MUST be testable without a real model and without waiting on real
  time: tests MUST be able to drive the model's structured answer and wait for the step to finish.

### Key Entities

- **Learning verdict**: The model's structured answer for one message: `hasLearning` (yes or no) and
  `fact` (the sentence to save). It exists only during the learning step and is never stored.
- **Memory**: Unchanged from feature 008. A learned fact is stored as an ordinary memory of the user,
  indistinguishable from one saved by `remember_fact`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A message that states a lasting fact without asking to remember it leads to that fact
  being recalled in a later conversation of the same user (verified by an automated test with a
  scripted model answer).
- **SC-002**: For a fixed set of one-off requests, and of messages containing secrets, 0 memories are
  stored (verified by automated tests, including a case where the model wrongly proposes a secret).
- **SC-003**: Reply time for a chat request with a user id is not increased by the learning step:
  the reply is sent before the step finishes (verified by a test where the step is held open).
- **SC-004**: In 100% of learning-step failures, the reply already sent is unchanged and the failure
  is logged.
- **SC-005**: Saying "forget that I ..." in a rewording of a saved preference removes exactly that
  one fact, and an unrelated description removes nothing.
- **SC-006**: Every existing chat flow, with or without a user id, keeps its current reply shape and
  status codes.

## Assumptions

- The learning step uses the same chat model the agent uses, with no extra configuration.
- The fact is written in English, in one short sentence that makes sense on its own (for example
  "The engineer is on the payments team and owns the checkout alerts"), because the embedding model
  is English-centric and recall compares facts with English-like queries.
- The learning step is bounded at 30 seconds; past that it is cancelled and logged as a failure.
- The removal threshold of 0.5 for `forget_preference` is a fixed setting, stricter than the recall
  minimum of 0.3, because removing the wrong fact is worse than recalling a weak one.
- The deterministic secret check is a safety net, not a complete detector; the model instruction is
  the first guard. A false positive only means a harmless fact is not learned.
- Learned facts are not reported in the reply, since the reply is sent first; they are logged.
- Pending learning steps are not awaited on shutdown in this feature.
- The MCP server, arena, and bench are out of scope and keep running without the learning step.
- Tests use a scripted model, a fake embedder, and an in-memory database; they never touch the real
  database file and never call a real model.
