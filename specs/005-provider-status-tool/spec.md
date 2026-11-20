# Feature Specification: Provider Status Tool

**Feature Branch**: `005-provider-status-tool`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "External provider status tool: check_provider_status in
src/agents/tools.ts queries the provider's public status page through the statuspage.io API (no
key): github -> `https://www.githubstatus.com/api/v2/status.json`, cloudflare ->
`https://www.cloudflarestatus.com/api/v2/status.json`. Parameter provider (enum github | cloudflare,
default "github", with a describe() explaining it). Description oriented to when to use it:
suspected external problem, 'is it ours or the provider's?', a dependency is down. Resilience:
5 s timeout via AbortSignal.timeout; on a network failure or 5xx, ONE retry; response validated
with zod ({status: {indicator, description}}); any final failure returns a readable error string
as the tool result (an error is an observation; never throw out of the tool). Compact result
(indicator + description, one line), so the context does not grow. Tests: the fetch function is
injectable; tests cover success, timeout, and invalid response with no network (fake fetch)." The
original Portuguese text is in `docs/prompts/0074-20261120-111033.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - "Is it ours or the provider's?" (Priority: P1)

During an incident the on-call engineer suspects an outside cause ("GitHub Actions is failing",
"is Cloudflare down?", "our deploys stopped"). They ask the copilot, and it checks the provider's
public status page and answers in one line whether the provider reports a problem, so the engineer
knows whether to dig into their own services or wait on the provider.

**Why this priority**: This is the whole feature. Telling an external outage apart from an
internal one early saves the shift from chasing the wrong cause.

**Independent Test**: With a fake status source that reports a partial outage for GitHub, call the
tool for `github`; it returns one line with the provider, the severity indicator, and the
description.

**Acceptance Scenarios**:

1. **Given** the GitHub status page reports `none` / "All Systems Operational", **When** the tool
   is called with `github`, **Then** it returns one line containing `github`, `none`, and
   "All Systems Operational".
2. **Given** the Cloudflare status page reports `minor` / "Minor Service Outage", **When** the
   tool is called with `cloudflare`, **Then** it returns one line containing `cloudflare`, `minor`,
   and "Minor Service Outage", and only the Cloudflare page was queried.
3. **Given** no provider is given, **When** the tool is called, **Then** it checks `github`.
4. **Given** a provider outside `github | cloudflare`, **When** the tool is called, **Then** the
   input is rejected before any request is made.

---

### User Story 2 - A broken status page never breaks the run (Priority: P1)

The status page itself can be slow, down, or return something unexpected. Whatever happens, the
copilot gets a readable error text it can reason about ("could not reach the GitHub status page")
and the conversation goes on; the run never crashes because of this tool.

**Why this priority**: The tool is used exactly when things are failing. A tool that throws during
an outage would take the copilot down with the provider.

**Independent Test**: With a fake status source that never answers, that fails twice, or that
returns malformed content, call the tool; each case returns an `Error: ...` text and no exception
escapes.

**Acceptance Scenarios**:

1. **Given** the status page does not answer within 5 seconds on both attempts, **When** the tool
   is called, **Then** it returns an `Error: ...` text that names the provider and says the check
   timed out.
2. **Given** the first attempt fails with a network error or a server error (5xx) and the second
   succeeds, **When** the tool is called, **Then** it returns the status line from the second
   attempt.
3. **Given** both attempts fail with a network error or a server error, **When** the tool is
   called, **Then** exactly two attempts were made and it returns an `Error: ...` text naming the
   provider and the failure.
4. **Given** the status page answers with a client error (4xx), **When** the tool is called,
   **Then** it is not retried and it returns an `Error: ...` text with the status code.
5. **Given** the status page answers with content that is not valid or lacks the indicator or the
   description, **When** the tool is called, **Then** it is not retried and it returns an
   `Error: ...` text saying the response was not understood.

---

### User Story 3 - The model knows when to call it (Priority: P2)

The tool description tells the model when this tool applies (a suspected external cause, "ours or
the provider's?", a dependency down) and when it does not (internal alerts and incidents, which
have their own tools), following the project's six description rules.

**Why this priority**: Without a clear "when to use", the model either never calls the tool or
calls it on every question, wasting time and context.

**Independent Test**: Inspect the tool definition: it says when to use it, its only argument has
a description and is an enumeration with a default, and it states what it returns and how errors
look.

**Acceptance Scenarios**:

1. **Given** the tool definition, **When** it is read, **Then** it names the situations that call
   for it and points to `list_alerts` / `list_incidents` for internal state.
2. **Given** the `provider` argument, **When** its schema is read, **Then** it is an enumeration
   `github | cloudflare` with default `github` and its own description.

---

### Edge Cases

- The status page answers slowly on the first attempt and fast on the second: the second answer
  is used.
- The status page answers with extra fields beyond the indicator and description: they are
  ignored and the line stays compact.
- The status page reports an indicator value not seen before (for example `maintenance`): it is
  reported as given, not rejected, as long as it is non-empty text.
- The description contains line breaks: they are collapsed so the result stays one line.
- The page answers 200 with an empty body or plain text (for example an HTML error page): treated
  as an invalid response, not retried.
- A redirect or an unexpected error inside the request machinery: caught and returned as an
  `Error: ...` text; nothing escapes the tool.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent MUST offer a tool named `check_provider_status` that reports the current
  overall status of an external provider from its public status page, which needs no credentials.
- **FR-002**: The tool MUST take one argument, `provider`, a closed set `github | cloudflare`
  with default `github`, carrying its own description. Each provider MUST map to a fixed status
  address: `github` to `https://www.githubstatus.com/api/v2/status.json`, `cloudflare` to
  `https://www.cloudflarestatus.com/api/v2/status.json`. The tool MUST NOT query any address
  that is not on this list.
- **FR-003**: Each attempt MUST be abandoned after 5 seconds.
- **FR-004**: On a network failure, a timeout, or a server error (5xx), the tool MUST make exactly
  one more attempt. Client errors (4xx) and invalid responses MUST NOT be retried. At most two
  attempts are made per call.
- **FR-005**: The response MUST be validated before use: it MUST contain a status with a
  non-empty indicator and a non-empty description. Anything else is an invalid response.
- **FR-006**: On success the tool MUST return a single line with the provider, the indicator, and
  the description, and nothing else from the status page.
- **FR-007**: On any final failure (timeout, network failure, server or client error, invalid
  response, or any unexpected error) the tool MUST return a readable text starting with the prefix
  `Error:`, naming the provider and the kind of failure, as its result. It MUST NOT throw.
- **FR-008**: The tool description MUST follow the six description rules: what it does, when to
  use it (suspected external problem, "is it ours or the provider's?", a dependency is down), a
  description on its argument, an enumeration for the closed set, what it returns, and what an
  error looks like.
- **FR-009**: The way the tool fetches the status page MUST be replaceable, so tests can supply a
  fake source.
- **FR-010**: Tests MUST NOT use the network. They MUST cover at least: success, timeout, and an
  invalid response; they SHOULD also cover the retry after a server error, the no-retry on a
  client error, and the default provider.
- **FR-011**: The tool MUST NOT read, write, or depend on the ops store; it is independent of
  services, alerts, incidents, and runbooks.

### Key Entities

- **Provider**: an external service the team depends on (`github`, `cloudflare`), each with one
  fixed public status address.
- **Provider status**: the provider's self-reported overall state: an indicator (`none`, `minor`,
  `major`, `critical`, or another value the provider uses) and a human-readable description.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Asked "is GitHub down or is it us?", the copilot answers from the provider's status
  in a single run, in one sentence. This depends on a live model and network, so it is verified
  manually; the tool itself is covered by automated tests.
- **SC-002**: A single tool call returns within about 10 seconds in the worst case (two attempts
  of up to 5 seconds each).
- **SC-003**: 100% of failure cases in the tests (timeout, repeated server errors, client error,
  invalid response, unexpected error) produce an `Error:` text and no exception.
- **SC-004**: A successful result is one line and stays under 200 characters for the descriptions
  the providers use today.
- **SC-005**: The test suite passes with no network access.

## Assumptions

- The request writes the field as "indicador"; it is the status page's `indicator` field, and the
  response shape is `{ status: { indicator, description } }` with other fields ignored.
- A timeout counts as a network failure, so it gets the one retry; the request lists "network
  failure or 5xx" and a timeout is the most common network failure.
- The one-line result also names the provider, so the model can tell results apart when it checks
  both providers in one run; this adds a single word.
- Only the overall status is reported; per-component status, open incidents, and scheduled
  maintenance from the status page are out of scope.
- The two status addresses are fixed in code; adding a provider means adding it to the closed set
  in a later change, not configuring it at run time.
- No caching: every call queries the status page, since the tool is used rarely and during live
  incidents when fresh data matters.
- The error text uses the same `Error:` prefix the existing tools already return for domain
  errors, so the model sees one error convention.
