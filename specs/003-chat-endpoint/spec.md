# Feature Specification: Chat Endpoint

**Feature Branch**: `003-chat-endpoint`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "POST /chat in src/http/server.ts (or the Express convention): body
{message, strategy?, reflect} validated with zod; default react. 200 {answer, trace, metrics}; 400
invalid body (zod issues); 422 unknown strategy; timeout 180s -> 504. Registry in
src/agents/index.ts (name -> strategy; reflect applies withReflection). Integration test with a
deterministic fake strategy, no network." The original Portuguese text is in
`docs/prompts/0037-20261102-124723.md`.

## Clarifications

### Session 2026-11-02

- Q: When the client leaves out `reflect`, is the request rejected or run without reflection? → A:
  Rejected; `reflect` is required and a body without it gets a 400.
- Q: When the strategy ends with an error, which HTTP status does the reply use? → A: 502, with the
  error's name and message and the partial trace and metrics.
- Q: Does the 200 reply include a `stopReason` field? → A: Yes; the 200 reply is
  `{answer, trace, metrics, stopReason}`, with `stopReason` `completed` or `iteration_limit`.
- Q: On a timeout (504), is the run cancelled or left running? → A: Cancelled; the timeout sends a
  cancel signal to the strategy and no new action starts after the 504.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask OpsPilot a question over HTTP (Priority: P1)

An on-call engineer, or a tool they use, sends a message to the chat endpoint. OpsPilot runs a
reasoning strategy on it and replies with the answer, the trace of what the agent did, and the run
metrics.

**Why this priority**: Today OpsPilot only runs from the command line. A chat endpoint is what lets
other tools and future interfaces use it.

**Independent Test**: Start the server with a fake strategy that returns a fixed result, send a
valid message, and confirm the reply holds that answer, trace, and metrics.

**Acceptance Scenarios**:

1. **Given** a running server, **When** a client sends
   `{ "message": "Which alerts are firing?", "reflect": false }` with no strategy, **Then** the
   `react` strategy runs and the reply is success (200) with `answer`, `trace`, `metrics`, and
   `stopReason` `completed`.
2. **Given** a running server, **When** a client sends a message with `"strategy": "plan-execute"`,
   **Then** that strategy runs instead of the default.
3. **Given** a run that stops at the iteration limit, **When** the reply is sent, **Then** it is
   success (200) with `answer` set to null, `stopReason` `iteration_limit`, and the full trace and
   metrics.

---

### User Story 2 - Turn reflection on per request (Priority: P2)

A client asks for reflection on a request. The chosen strategy runs with the reflection layer, so
the answer is checked against the observations before it is returned.

**Why this priority**: Reflection already exists for the arena; exposing it per request lets
clients trade extra cost for a checked answer, but only once the endpoint works.

**Independent Test**: Send the same message with reflection on and off to a server whose registry
uses a fake strategy, and confirm the reflected run is the reflection layer around that strategy.

**Acceptance Scenarios**:

1. **Given** `"reflect": true`, **When** the request runs, **Then** the strategy runs inside the
   reflection layer and the trace may hold critique events.
2. **Given** `"reflect": false`, **When** the request runs, **Then** the plain strategy runs with no
   critique.

---

### User Story 3 - Get a clear error for a bad request or a slow run (Priority: P3)

A client that sends a malformed body, names a strategy that does not exist, or waits on a run that
takes too long gets a distinct, explained error instead of a hang or a generic failure.

**Why this priority**: Clear errors make the endpoint usable by other tools, but they matter only
once the happy path works.

**Independent Test**: Send each kind of bad request to a server with a fake strategy and a short
timeout, and check the status code and body of each reply.

**Acceptance Scenarios**:

1. **Given** a body with no message, an empty message, no `reflect`, a wrong field type, or text that is not
   JSON, **When** it is sent, **Then** the reply is a bad request (400) listing each validation
   issue with its field and message.
2. **Given** `"strategy": "chain-of-thought"`, **When** it is sent, **Then** the reply is
   unprocessable (422), names the unknown strategy, and lists the known ones.
3. **Given** a run that does not finish within the timeout (180 seconds by default), **When** the
   timeout passes, **Then** the reply is a gateway timeout (504), the run is cancelled, and no later
   result is sent.
4. **Given** a run cancelled by the timeout, **When** it would take its next action, **Then** no
   tool call starts after the 504 is sent.
5. **Given** a run that stops with an error, **When** the reply is sent, **Then** it is a bad
   gateway (502) with the error's name and message and the trace gathered so far.

---

### Edge Cases

- `reflect` sent as a string such as `"true"`: it is not a boolean, so the reply is 400.
- A body with extra fields: the extra fields are ignored and the request runs.
- A strategy name in a different case, such as `React`: it is unknown (422); names are exact.
- A strategy name already prefixed, such as `reflect:react`: it is unknown (422); reflection is
  asked for only with `reflect`.
- A message that is only whitespace: it counts as empty (400).
- A body that fails validation and also names an unknown strategy: the body is checked first, so the
  reply is 400.
- A run that throws instead of returning a result: the reply is 502 with the error's name and
  message, and never a stack trace or a secret.
- A tool call already in progress when the timeout fires: it may finish, but no further step runs
  and the run's result is discarded.
- A reflected run that times out: the cancel reaches the base attempts and the critic alike.
- A request to another method or path: the reply is not found (404), handled by the server's default
  behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `POST /chat` that accepts a JSON body with `message` (required,
  non-empty text), `strategy` (optional name, default `react`), and `reflect` (required true or
  false).
- **FR-002**: The body MUST be validated at the boundary before any strategy runs; an invalid body
  MUST get a 400 reply listing each issue's field path and message.
- **FR-003**: A strategy name not in the registry MUST get a 422 reply that names it and lists the
  known strategy names.
- **FR-004**: A strategy registry MUST map each strategy name to a way of building that strategy,
  and MUST apply the reflection layer when reflection is asked for.
- **FR-005**: The registry MUST hold `react` and `plan-execute` at first.
- **FR-006**: A completed run MUST get a 200 reply with `answer`, `trace`, `metrics`, and
  `stopReason` `completed`.
- **FR-007**: A run stopped at the iteration limit MUST get a 200 reply with `answer` null,
  `stopReason` `iteration_limit`, and its trace and metrics.
- **FR-008**: A run stopped by an error, or one that throws, MUST get a 502 reply with the error's
  name and message, and the trace and metrics when the run returned them.
- **FR-009**: A run that does not finish within the timeout MUST get a 504 reply. The timeout MUST
  default to 180 seconds and MUST be settable when the server is built, so tests can shorten it.
- **FR-009a**: On timeout, the system MUST cancel the run: strategies, including the reflection
  layer, MUST accept a cancel signal and MUST NOT start a new model or tool call once it fires.
- **FR-010**: The reply body MUST be validated against its declared shape before it is sent.
- **FR-011**: Error replies MUST never hold a stack trace, a setting's value, or a secret.
- **FR-012**: The server MUST be buildable with an injected registry and model, so tests can run it
  with a fake strategy and no network.
- **FR-013**: The endpoint MUST have integration tests over real HTTP against a server on a local
  port, using a deterministic fake strategy, that cover 200, 400, 422, 502, and 504, and that
  check the fake strategy received the cancel signal on timeout.

### Key Entities

- **Chat Request**: The message to answer, the strategy name, and whether to reflect.
- **Chat Reply**: The answer (or null), why the run stopped, the trace of thoughts, actions, observations, plans,
  critiques, and the answer, and the metrics (LLM calls and latency).
- **Strategy Registry**: The set of known strategy names, each with a way to build its strategy,
  plus the rule that wraps a strategy with reflection on request.
- **Error Reply**: The kind of error and its details: validation issues, the unknown name with the
  known names, the run error, or the timeout.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client gets an answer, a trace, and metrics from one request, with no command line.
- **SC-002**: Each failure kind (invalid body, unknown strategy, run error, timeout) gets its own
  status code on 100% of test requests.
- **SC-003**: A client waits at most the timeout plus 1 second before getting a reply.
- **SC-004**: The integration tests pass with no network access and finish in under 5 seconds.
- **SC-005**: The arena and the endpoint offer the same strategy names from one registry, so a new
  strategy added once appears in both.

## Assumptions

- The request does not choose the iteration limit; the endpoint uses the same default as the arena,
  10.
- The 200 reply with a null answer at the iteration limit is a default chosen here; the request
  named only 200, 400, 422, and 504.
- The request body is limited by the server's default JSON size limit.
- Strategies take no cancel signal today; adding one to the run options is part of this feature.
- The endpoint lives in `src/http/` and the registry in `src/agents/index.ts`, as the request says;
  the arena moves to the shared registry and keeps its `reflect:` names.
- The server runs against the JSON file store the arena uses. Authentication, rate limits, streaming
  replies, and chat history are out of scope.
- `npm run dev` starts the server; the port comes from a `PORT` setting with a default of 3000.
