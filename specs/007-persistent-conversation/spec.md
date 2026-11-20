# Feature Specification: Persistent Conversation

**Feature Branch**: `007-persistent-conversation`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "Persistent conversation: a ConversationStore (append / lastMessages /
create) plus a messages table, in the same style as SqliteOpsStore. /chat takes an optional
conversationId and returns it in the reply. The last 12 messages go into the prompt through
composition; new metric historyMessages. Tests on ':memory:' plus a fake." The original Portuguese
text is in `docs/prompts/0103-20261120-141106.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Follow-up questions keep their context (Priority: P1)

An on-call engineer asks OpsPilot "which alerts are firing on checkout?", gets an answer, and then
asks "open an incident for the worst one". Today the second request has no memory of the first, so
"the worst one" means nothing. With this feature the engineer sends the conversation id they got
back from the first reply, and the copilot answers the follow-up with the earlier exchange in view.

**Why this priority**: Multi-turn triage is the main reason a chat copilot exists. Without memory
every request must restate the full context, which is slow and error-prone during an incident.

**Independent Test**: Send a first message without a conversation id, keep the id from the reply,
send a second message with that id, and check that the agent received the first question and its
answer ahead of the new message.

**Acceptance Scenarios**:

1. **Given** no conversation id, **When** the engineer sends a message, **Then** the reply carries
   a new conversation id and the history count is 0.
2. **Given** a conversation with one completed exchange, **When** the engineer sends a new message
   with that conversation id, **Then** the agent receives the earlier question and answer in order
   before the new message, the reply carries the same conversation id, and the history count is 2.
3. **Given** a completed exchange, **When** the reply is returned, **Then** both the engineer's
   message and the copilot's answer are saved to the conversation.

---

### User Story 2 - Conversations survive a restart (Priority: P2)

The engineer keeps a conversation open across a deploy of OpsPilot. After the service restarts,
sending the same conversation id still brings back the earlier exchanges.

**Why this priority**: Incidents last longer than a process lifetime. Memory that vanishes on
restart breaks the follow-up flow exactly when the service is being changed.

**Independent Test**: Save an exchange in a store backed by a database file, close it, open a new
store on the same file, and read the same messages back.

**Acceptance Scenarios**:

1. **Given** a conversation with saved messages, **When** the service restarts and the engineer
   sends a message with that conversation id, **Then** the earlier messages are part of the
   context.

---

### User Story 3 - Long conversations stay bounded (Priority: P3)

During a long incident a conversation grows to dozens of messages. The copilot only sends the most
recent 12 messages as context, so cost and latency per request stay flat, and the reply reports how
many earlier messages were used.

**Why this priority**: Unbounded history makes each turn slower and more expensive and can push the
request past the model's limits. The metric lets engineers see what context the answer was built
on.

**Independent Test**: Seed a conversation with 20 messages, send one more, and check that the agent
received exactly the 12 most recent earlier messages, oldest first, and that the history count is
12.

**Acceptance Scenarios**:

1. **Given** a conversation with 20 saved messages, **When** a new message is sent, **Then** only
   the 12 most recent earlier messages are used, in chronological order, and the history count is
   12.
2. **Given** a conversation with 5 saved messages, **When** a new message is sent, **Then** all 5
   are used and the history count is 5.

---

### Edge Cases

- A conversation id that does not exist is rejected with a clear "conversation not found" error.
  No new conversation is created in its place, and the agent does not run.
- A conversation id that is empty or malformed is rejected as an invalid request body.
- A run that fails or times out saves nothing, so a retry does not duplicate the question.
- A run that hits the iteration limit with no answer saves nothing, so the history never holds a
  question without its answer.
- When a new conversation is created and the run then fails, the conversation exists with no
  messages. The error reply still names that conversation id, so the engineer can retry in it.
- Two requests on the same conversation at the same time each see the history as it was when they
  started. Their messages are saved in the order the runs finish.
- The same conversation can be continued with a different strategy or reflection setting.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The chat request MUST accept an optional conversation id.
- **FR-002**: When the request has no conversation id, the system MUST create a new conversation
  before the run and return its id.
- **FR-003**: Every chat reply produced after the conversation is known (success, run failure, or
  timeout) MUST include the conversation id it belongs to.
- **FR-004**: When the request has a conversation id that does not exist, the system MUST reply
  with a "conversation not found" error that names the id, and MUST NOT run the agent.
- **FR-005**: Before the run, the system MUST load the most recent earlier messages of the
  conversation, up to 12, in chronological order (oldest first).
- **FR-006**: The system MUST give the agent those earlier messages, each marked as coming from the
  engineer or from the copilot, ahead of the new message.
- **FR-007**: The history MUST reach the agent through the existing prompt-building path, so every
  strategy (with or without reflection) receives the same history without strategy-specific code.
- **FR-008**: After a run that completes with an answer, the system MUST save the engineer's
  message and then the copilot's answer to the conversation, in that order.
- **FR-009**: A run that fails, times out, or ends without an answer MUST NOT save any message.
- **FR-010**: Every chat reply that carries metrics MUST report `historyMessages`: the number of
  earlier messages given to the agent (0 to 12).
- **FR-011**: Saved conversations and messages MUST persist across restarts, in the same database
  as the operations data.
- **FR-012**: The conversation storage MUST offer three operations: create a conversation, append a
  message, and read the last N messages of a conversation.
- **FR-013**: The conversation storage MUST have a durable implementation and a test double that
  follow the same contract, and both MUST pass the same contract tests.
- **FR-014**: Message author roles MUST be a closed set (engineer, copilot), enforced both where
  input enters and where data is stored.
- **FR-015**: Only the message text and its role are saved; the trace and metrics of a run are not.

### Key Entities

- **Conversation**: A thread of exchanges between an engineer and the copilot. Has an opaque,
  server-generated id and a creation time.
- **Message**: One turn inside a conversation. Has the conversation it belongs to, a role
  (engineer or copilot), the text, a creation time, and a position that fixes its order inside the
  conversation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of follow-up requests that carry a valid conversation id, the agent receives
  the earlier exchanges of that conversation.
- **SC-002**: The context given to the agent never holds more than 12 earlier messages, whatever
  the length of the conversation.
- **SC-003**: After a restart, 100% of saved conversations can be continued with their earlier
  messages intact and in order.
- **SC-004**: Every successful reply states which conversation it belongs to and how many earlier
  messages it used, so an engineer can tell what context an answer was built on.
- **SC-005**: No failed, timed-out, or unanswered request leaves a message in the conversation
  history.
- **SC-006**: Every existing chat flow (no conversation id sent) keeps working, with the only
  visible change being the two new reply fields.

## Assumptions

- There is no authentication, so anyone holding a conversation id can continue it. Ids are random
  and hard to guess, which is enough for this course project.
- The window of 12 counts messages, not exchanges, so it covers the last 6 question-and-answer pairs
  in a normal conversation. It is a fixed setting, not a request parameter.
- Messages are kept with no retention limit and there is no way to list or delete conversations in
  this feature.
- The new reply fields are additive: clients that ignore them keep working.
- The 404 for an unknown conversation id is a new domain error, translated at the HTTP edge like
  the existing unknown-strategy error.
- The MCP server and the arena/bench commands are out of scope; they keep running single-turn.
- Tests use an in-memory database and a fake store; they never touch the real database file.
