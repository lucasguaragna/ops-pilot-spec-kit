# Feature Specification: History Summarization

**Feature Branch**: `011-history-summarization`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "History summarization (pruning): a conversation_summaries table. What
leaves the 8 most recent messages becomes a summary of about 150 tokens that keeps decisions, facts,
and open items. It is MERGED with the previous summary and persisted, and it is redone only when 8
new messages have left the window, never on every request. The summary goes into the context; a
summarize event. With a fake test." The original Portuguese text is in
`docs/prompts/0137-20261124-200548.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A long conversation keeps its early decisions (Priority: P1)

An on-call engineer works through an incident in one long conversation. In the first exchanges
they decide things ("we page the payments team", "INC-002 stays open until the deploy finishes"),
state facts ("checkout-api runs on the eu-west cluster"), and leave open items ("check the
dashboard after the rollback"). Today only the last 12 messages reach the agent, so after 6
exchanges those early decisions are gone. With this feature the agent always gets the most recent
8 messages word for word plus a short summary of everything before them. On the 20th exchange the
agent still knows what was decided in the first.

**Why this priority**: This is the value of the feature: long conversations stop forgetting, while
the context stays small.

**Independent Test**: Seed a conversation with 16 earlier messages and a stored summary, send a new
message with a fake strategy, and check that the input the agent receives holds the summary, then
the recent messages, then the current request.

**Acceptance Scenarios**:

1. **Given** a conversation with a stored summary, **When** a new message is sent, **Then** the
   agent receives the summary, clearly labelled, ahead of the recent messages and the current
   request.
2. **Given** a conversation with 8 or fewer earlier messages and no summary, **When** a new message
   is sent, **Then** the agent's input is exactly what it is today.
3. **Given** a decision stated in the first exchange of a 20-exchange conversation, **When** the
   20th message is sent, **Then** the decision is in the agent's context, inside the summary.
4. **Given** a request with a `userId`, **When** the agent's input is built, **Then** the
   remembered facts still come first, then the summary, then the recent messages, then the current
   request.

---

### User Story 2 - The summary is refreshed in batches, merged, and kept (Priority: P2)

Summarizing costs a model call, so it must not run on every request. The system keeps track of
how many messages the stored summary already covers. Only when at least 8 messages that are older
than the recent window are not yet covered does it summarize. It hands the summarizer the previous
summary and exactly those messages, and gets back one new summary that keeps what still holds:
earlier decisions, facts, and open items stay unless the new messages settle or change them. The
new summary replaces the old one in storage, together with how many messages it now covers, so it
survives a restart.

**Why this priority**: Without the batching rule the feature would double the number of model calls
of a long conversation; without merging, each refresh would forget what the previous one kept.

**Independent Test**: Drive a conversation through 20 exchanges against a fake summarizer that
counts its calls and records its inputs. Check it ran exactly on exchanges 9, 13, and 17, that each
call received the previous summary and 8 messages, and that a fresh store opened on the same file
returns the last summary.

**Acceptance Scenarios**:

1. **Given** fewer than 8 uncovered messages older than the window, **When** a request arrives,
   **Then** no summarization runs and the stored summary is unchanged.
2. **Given** exactly 8 uncovered messages older than the window, **When** a request arrives,
   **Then** one summarization runs, it receives the previous summary (or none) and those 8 messages
   in order, and the stored summary now covers them.
3. **Given** a previous summary that lists an open item, **When** the new messages do not resolve
   it, **Then** the merged summary still lists it.
4. **Given** a previous summary with an open item, **When** the new messages resolve it, **Then**
   the merged summary records it as resolved or drops it from the open items.
5. **Given** a stored summary, **When** the server restarts and the conversation continues,
   **Then** the stored summary is used and no extra summarization runs.

---

### User Story 3 - The engineer can see when the history was summarized (Priority: P3)

On the request where a summarization ran, the reply's trace starts with a `summarize` event that
carries the new summary and how many messages it absorbed. On every other request there is no such
event. When summarization fails, the request still answers as if there were no new summary, and the
server log says why.

**Why this priority**: It makes the pruning visible for teaching and debugging, but the agent works
without it.

**Independent Test**: With a fake summarizer, send the request that crosses the threshold and check
the trace's first event is `summarize` with the scripted summary and a count of 8. Then send one
more request and check its trace has no `summarize` event. Make the fake summarizer fail and check
the reply is still a 200 with no `summarize` event.

**Acceptance Scenarios**:

1. **Given** a request that triggers summarization, **When** the reply is returned, **Then** its
   trace's first event is `summarize` with the new rendered summary and the number of messages
   absorbed.
2. **Given** a request that does not trigger it, **When** the reply is returned, **Then** the trace
   has no `summarize` event.
3. **Given** the summarizer fails, times out, or returns no usable summary, **When** the request
   runs, **Then** the status, answer, and trace are what they would have been without a new
   summary (the metrics include the calls made), the stored summary is unchanged, the server logs
   one line with the reason, and no new attempt is made until the next batch of 8 closes.

---

### Edge Cases

- A conversation shorter than the window (8 messages or fewer): no summary, no summarization, and
  the context is the same as today.
- The summarizer returns an empty reply, or only lines that are dropped: treated as a failure;
  nothing is stored.
- The summarizer returns more than fits: whole lines are dropped from the end as FR-006 says, and
  the trimmed summary is stored.
- The run that follows a successful summarization fails or times out: the summary is kept, because
  it only covers messages that were already saved before this request.
- An unknown `conversationId`: the request fails with 404 before any summarization, as today.
- Two requests in the same conversation at the same time: a summary is stored only if the coverage
  it was computed from is still the stored one, so no message is summarized twice or skipped.
- A message with a pasted token or password: any summary line that repeats it is dropped before
  storage (FR-013), so the secret never reaches the summary, the trace, or a later context.
- A message that contains an id such as `INC-002` or a service name: the summarizer is told to keep
  names, dates, and deadlines, so the agent can still act on them.
- The summarizer keeps failing (provider down): the agent still gets the summary and the newest
  14 messages; the messages between them are left out until the next successful attempt absorbs
  them, and each attempt waits for the next batch boundary.
- A request that is cancelled by the run timeout while summarizing: summarization counts against
  its own limit, so the run still gets its full time.

- A conversation with 10 to 14 earlier messages and no summary yet: every earlier message still
  reaches the agent word for word (FR-003), so nothing is lost before the first summarization.

## Clarifications

### Session 2026-11-24

- Q: Until a batch of 8 is complete, do older messages that are not yet summarized still reach the
  agent? → A: Yes, word for word, after the summary and before the recent window (8 to 14 messages
  plus the summary).
- Q: When a batch of 8 is complete, does summarization run inside the request, before the agent,
  or in the background after the reply? → A: Inside the request, before the agent runs.
- Q: Is the summary stored as free text or as three separate lists (decisions, facts, open
  items)? → A: Free text, as telegraphic bullet points, following the example in
  `docs/code-examples/spec11-example.ts` (changed on 2026-11-25; the first answer was three lists).
  The summarizer is a plain model call, the summary is stored as one text, and it is rendered as
  one labelled block in the context.
- Q: Does the summary go through the 009 secret check before it is stored? → A: Yes; every line
  goes through the same deterministic check, a line that looks like a secret is dropped, the rest
  is stored, and the log says how many lines were dropped.
- Q: After a failed summarization, when is it retried, and how many calls may one attempt make?
  → A: Only when the next batch of 8 closes (not on the next request), with one model call per
  attempt (from `/speckit-analyze`, finding C1).

### Session 2026-11-25

- Q: Which format and prompt does the summarizer follow? → A: The example in
  `docs/code-examples/spec11-example.ts`: compress to at most 150 tokens, keep decisions, facts
  (names, dates, deadlines, preferences), incidents opened or resolved, and open items, drop
  greetings and small talk, fold in the previous summary, and reply with the summary only as
  telegraphic bullets. The prompt is in English; the code enforces a ceiling of 300 estimated tokens.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent MUST receive the most recent 8 messages of the conversation word for word.
  This window replaces today's limit of 12 messages, which dropped older messages for good.
- **FR-002**: Messages older than the window MUST be represented by one summary per conversation,
  stored in its own persistent table (`conversation_summaries`) together with how many of the
  conversation's oldest messages it covers. The summary MUST survive a restart.
- **FR-003**: Older messages that are not yet covered by the summary MUST still reach the agent
  word for word, right after the summary and before the recent window, until their batch is
  summarized. The agent therefore sees every message either in the summary or word for word, never
  neither: 8 to 14 messages word for word plus the summary.
- **FR-004**: Summarization MUST run only on a batch boundary: when the uncovered messages older
  than the window have just reached 8, 16, 24, and so on (8 or more, and a multiple of 8 within
  the last exchange). It MUST then absorb all of those messages, oldest first. Any other request
  MUST make no summarization call, so a failed attempt is retried only when the next batch of 8
  closes, never on the next request. It MUST run inside the request, after the history is
  loaded and before the agent runs, so the new summary is already in that request's context.
- **FR-005**: Summarization MUST merge: the summarizer receives the previous summary (if any) and
  the messages being absorbed, and returns one summary that keeps the decisions, facts, and open
  items that still hold. Lines the new messages settle or change are updated.
- **FR-006**: The summary MUST target about 150 tokens (the prompt asks for at most 150) and the
  rendered summary MUST NOT exceed 300 estimated tokens (characters divided by 4, the project's
  existing estimate). When it would, whole lines are dropped from the end until it fits.
- **FR-007**: The summarizer MUST answer with the summary only, as telegraphic bullet points, in a
  plain model call. The reply is cleaned: lines are trimmed and blank lines dropped. The summary is
  stored as one text and rendered as one labelled block when it enters the context. The prompt
  asks it to keep decisions, facts (names, dates, deadlines, preferences), incidents opened or
  resolved, and open items, and to drop greetings and small talk.
- **FR-008**: The agent's context MUST be, in order: the remembered facts (when the request has a
  `userId`), the summary (when there is one) under its own label, the messages given word for word
  (uncovered older messages, then the recent window, oldest first), then the current request. With no summary, the context MUST be exactly as it is today.
- **FR-009**: On the request where a summarization succeeded, the reply's trace MUST start with a
  `summarize` event that carries the new summary and the number of messages absorbed. The reply
  schemas MUST accept this event, and no other request MUST carry one.
- **FR-010**: A summarization that fails, times out, or returns no usable summary MUST NOT fail the
  request. The status, the answer, and the trace are what they would have been without a new
  summary. The metrics still include the summarization calls that were made (FR-011). The stored
  summary stays unchanged, the server logs one line with the reason (never the message
  contents), and the next attempt happens at the next batch boundary (FR-004). Each attempt makes
  exactly one model call.
- **FR-011**: The summarization call MUST be counted in the reply's `metrics.llmCalls` and
  `metrics.promptTokens`. `metrics.historyMessages` MUST count the messages given word for word,
  and `metrics.contextBreakdown.history` MUST include the rendered summary.
- **FR-012**: A summary MUST be stored only when the coverage it was computed from is still the
  stored coverage, so concurrent requests never summarize a message twice or skip one.
- **FR-013**: Before a summary is stored, every line MUST go through the same deterministic secret
  check as learned facts (feature 009: passwords, keys, tokens, credentialed URLs). A line that
  looks like a secret is dropped and the rest is stored. The server log line says how many lines
  were dropped, never their text. If every line is dropped, the summarization counts as a failure
  (FR-010).
- **FR-014**: Summarization, the batching rule, the merge input, the secret check, the
  persistence, and the trace event MUST each ship with tests that use a fake model, never the
  real provider, and never the database under `data/`.

### Key Entities

- **Conversation summary**: one per conversation; the merged summary text, how many of the
  conversation's oldest messages it covers, and when it was last updated. Stored in the
  `conversation_summaries` table next to the conversations and messages.
- **Recent window**: the newest 8 messages of a conversation, given to the agent word for word.
- **Summarize event**: a trace event on the request that refreshed the summary, with the new
  summary as rendered for the context and the number of messages it absorbed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a 20-exchange conversation, a decision stated in the first exchange is in the
  agent's context on the 20th exchange.
- **SC-002**: Over 20 exchanges in one conversation, summarization runs exactly 3 times (on
  exchanges 9, 13, and 17), so at most 1 extra model call per 4 exchanges, whether the
  summarizer succeeds or fails.
- **SC-003**: However long the conversation, the history part of the context never holds more
  than 14 messages word for word plus one summary of at most 300 estimated tokens.
- **SC-004**: 100% of requests that would succeed without summarization still succeed when
  summarization fails.
- **SC-005**: After a restart, the next request in a summarized conversation uses the stored summary
  and makes no summarization call.
- **SC-006**: The type check and the full test suite stay green, with new tests covering the
  batching rule, the merge input, the secret check, persistence, the context order, the trace
  event, and the failure path.

## Assumptions

- Running summarization inside the request (FR-004) adds one model call of latency to about 1
  request in 4 of a long conversation. That is the price of having the `summarize` event in the
  trace of the reply that triggered it.
- Summarization has its own time limit of 30 seconds, outside the 180-second run timeout.
- The summarizer uses the same model as the agent. Its prompt is in English, and the summary
  follows the language of the conversation.
- "About 150 tokens" is measured with the project's existing estimate (characters divided by 4).
- The batch size and the window are both 8 messages, as in the description, and are not
  configurable per request.
- The summary is derived from messages already persisted in the same file, and the secret check
  keeps secrets out of it. Stored prompt injection through the history is the same risk as today
  and is not addressed here.
- The learning step (009) and the semantic memory (008) are unchanged; the summary does not become
  a memory.
- The MCP server, the `/chat` request body, and the store of alerts and incidents are unchanged.
