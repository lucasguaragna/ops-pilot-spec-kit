# Feature Specification: Context Measurement

**Feature Branch**: `010-context-measurement`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Instrument context measurement: src/context/tokens.ts with
estimateTokens (chars/4) and LangChain's real usage; /chat metrics with the real promptTokens and a
contextBreakdown estimated per source; the long-conversation script prints the promptTokens per
turn. With tests." The original Portuguese text is in `docs/prompts/0123-20261124-133436.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The engineer sees how many prompt tokens a reply really cost (Priority: P1)

An engineer sends a message to `POST /chat`. Next to `llmCalls` and `latencyMs`, the reply's
metrics now carry `promptTokens`: the number of input tokens the model provider reported for the
run, summed over every model call the run made (planning, each ReAct step, the critique when
reflection is on). This is the number the provider bills, not a guess.

**Why this priority**: Without the real count there is no ground truth. Every other number in this
feature is an estimate that is only useful when it can be compared with the real one.

**Independent Test**: Run a chat against a fake model that reports a fixed input usage per call
(for example 120 tokens per call over 3 calls) and check that the reply's `metrics.promptTokens`
is 360.

**Acceptance Scenarios**:

1. **Given** a run that makes 3 model calls and the provider reports 100, 150 and 200 input
   tokens, **When** the reply is returned, **Then** `metrics.promptTokens` is 450.
2. **Given** a provider that reports no usage for any call, **When** the reply is returned,
   **Then** `metrics.promptTokens` is `null` and the reply is still a 200.
3. **Given** a run that fails with `run_failed` after 2 model calls, **When** the 502 body carries
   metrics, **Then** `promptTokens` covers those 2 calls.
4. **Given** reflection is on, **When** the critique call runs, **Then** its input tokens are part
   of `promptTokens`.

---

### User Story 2 - The engineer sees which sources fill the context (Priority: P2)

The same reply carries `contextBreakdown`: an estimate, in tokens, of how much each source
contributed to the context the agent started the run with. The sources are the system
instructions, the tool definitions, the conversation history, the recalled memories, and the
current message. Each estimate uses the same rule: characters divided by 4, rounded up. The
breakdown also carries the total of those parts, so the engineer can see at a glance which source
grows and how far the estimate is from the real first-call count.

**Why this priority**: The real count says how big the context is; the breakdown says why. It is
what makes a growing history or a heavy tool list visible, but it is only meaningful next to the
real count from Story 1.

**Independent Test**: Call the breakdown builder with known inputs (a 400-character system
prompt, two tool definitions totalling 800 characters, 4 history messages totalling 1,000
characters, no memories, a 40-character message) and check it returns 100, 200, 250, 0, 10 and a
total of 560.

**Acceptance Scenarios**:

1. **Given** a request with no `conversationId` and no `userId`, **When** the reply is returned,
   **Then** `contextBreakdown.history` and `contextBreakdown.memories` are 0 and the other sources
   are positive.
2. **Given** a conversation with 6 earlier messages, **When** a new message is sent in it,
   **Then** `contextBreakdown.history` is the estimate of those 6 messages' text.
3. **Given** a user with 3 recalled memories, **When** the reply is returned, **Then**
   `contextBreakdown.memories` is the estimate of the memory block the agent was given.
4. **Given** any reply with metrics, **When** the breakdown is read, **Then** `total` equals the
   sum of the source estimates.

---

### User Story 3 - The long-conversation script shows the context growing turn by turn (Priority: P3)

An engineer runs the long-conversation script against a running server. It sends a fixed series of
messages in one conversation and, after each turn, prints one line with the turn number, the real
`promptTokens`, and the estimated history size. At the end the engineer sees how the prompt grows
with the history, and where it levels off once the history limit (12 messages) is reached.

**Why this priority**: It is the demo that turns the two numbers into a lesson, but it only reads
what Stories 1 and 2 already put in the reply.

**Independent Test**: Run the script against a server started with a fake model and check it
prints one line per turn, each with a number or `n/a` for `promptTokens`.

**Acceptance Scenarios**:

1. **Given** a running server, **When** the script runs with its default 10 turns, **Then** it
   prints 10 turn lines and every turn after the first reuses the same `conversationId`.
2. **Given** a turn fails with a 502 or 504, **When** the script reads the reply, **Then** it
   prints the error code for that turn and continues with the next one.
3. **Given** the server reports `promptTokens` as `null`, **When** the line is printed, **Then**
   it shows `n/a` instead of a number.
4. **Given** the server is not running, **When** the script starts, **Then** it exits with a
   non-zero status and a one-line message naming the URL it tried.

---

### Edge Cases

- A provider reports usage on some calls and not on others: `promptTokens` is the sum of the
  reported calls. Only when no call reports usage is it `null`.
- A run times out (504): the timeout body carries no metrics today and still carries none.
- A run that throws before any model call (502 without partial metrics): no metrics, unchanged.
- Empty strings estimate to 0 tokens; a 1-character string estimates to 1 (rounded up).
- Non-ASCII text (Portuguese accents, emoji): the estimate counts characters as the language's
  string length reports them; it is an approximation and is documented as one.
- The ReAct loop adds tool observations to the context between calls. Those are not a source in
  the breakdown, which describes the starting context only; they show up only in the real
  `promptTokens`.
- A user message that is very long: the estimate stays linear and never throws.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a pure function `estimateTokens(text)` that returns
  `ceil(length / 4)` for a string, and 0 for an empty string.
- **FR-002**: The system MUST read the input token count that the model provider reports for each
  model call in a run, from the usage metadata the chat model library exposes, and sum it per run.
- **FR-003**: The run's metrics MUST carry `promptTokens` as a non-negative integer, or `null`
  when no model call in the run reported usage.
- **FR-004**: The `POST /chat` 200 reply MUST carry `metrics.promptTokens` and
  `metrics.contextBreakdown`.
- **FR-005**: `contextBreakdown` MUST hold one non-negative integer estimate per source: `system`,
  `tools`, `history`, `memories`, `message`, plus `total`, the sum of the five.
- **FR-006**: The breakdown MUST be built by a pure function from the texts the agent was given:
  the system instructions of the chosen strategy, the serialised tool definitions (names,
  descriptions, and argument schemas), the history messages, the rendered memory block, and the
  current message.
- **FR-007**: A `run_failed` 502 body that carries metrics today MUST carry `promptTokens` and
  `contextBreakdown` with the same meaning.
- **FR-008**: The reply schemas MUST validate the new fields, and the existing fields
  (`llmCalls`, `latencyMs`, `historyMessages`, `recalledMemories`) MUST keep their meaning.
- **FR-009**: The token counting MUST not add any model call and MUST not change the answer, the
  trace, or the stop reason of a run.
- **FR-010**: A long-conversation script MUST send a fixed series of messages in one conversation
  to a running server and print, per turn, the turn number, `promptTokens` (or `n/a`), and the
  history estimate. The server URL and the number of turns MUST be configurable, with defaults of
  the local dev server and 10 turns.
- **FR-011**: The script MUST print the error code of a failed turn and continue, and MUST exit
  non-zero with a clear message when the server cannot be reached.
- **FR-012**: The estimator, the usage summing, the breakdown builder, and the reply mapping MUST
  each ship with tests that use a fake model, never the real provider.

### Key Entities

- **Token estimate**: an integer approximation of a text's size in tokens, `ceil(characters / 4)`.
- **Prompt usage**: the input token counts the provider reported for a run's model calls, and their
  sum; absent when the provider reports none.
- **Context breakdown**: the per-source estimates of the starting context (system, tools, history,
  memories, message) and their total.
- **Turn line**: what the long-conversation script prints for one turn: turn number, real prompt
  tokens or `n/a`, history estimate, or an error code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of successful `/chat` replies carry a prompt token count (or an explicit
  "not reported") and a breakdown whose parts add up to its total.
- **SC-002**: For a single-call run, the breakdown total is within 30% of the real prompt token
  count reported by the provider, on the long-conversation script's messages.
- **SC-003**: Running the long-conversation script once, an engineer can tell from its output
  alone on which turn the history stops growing.
- **SC-004**: Measuring the context adds no extra model call and no visible latency: the number of
  model calls per run is unchanged.
- **SC-005**: The type check and the full test suite stay green, with new tests covering the
  estimator, the usage sum, the breakdown, the reply mapping, and the script's output format.

## Assumptions

- `promptTokens` is the sum over all model calls in the run, because that is what the provider
  bills; a multi-step ReAct run therefore reports several times the size of one context. The
  breakdown describes one context (the starting one), so the two are compared on single-call runs.
- OpenRouter returns usage for the models this project uses; when a model does not, `null` is the
  honest answer and the reply still succeeds.
- Characters divided by 4 is the classic rough rule for English text; it is kept on purpose as a
  teaching baseline, and the gap to the real count is part of what the feature shows.
- The memory block and the history are measured as the agent actually receives them (after the
  history limit of 12 messages and the recall limit of 3 memories), not as stored.
- The script is a shell script in a new `scripts/` directory, named `long-conversation.sh` (the
  course calls it `conversa-longa.sh`; project files use English names). It needs `curl` and
  `jq`.
- The timeout reply (504) keeps carrying no metrics; adding them is out of scope.
- The trace and the `/chat` request body are unchanged.
