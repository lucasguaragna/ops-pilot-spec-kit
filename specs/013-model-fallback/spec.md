# Feature Specification: Model Fallback

**Feature Branch**: `013-model-fallback`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "Model resilience: `.env`: `OPENROUTER_MODEL_FALLBACK`; model factory
`model.ts`: `withRetry` on the primary model, `withFallbacks([fallback])`; trace: a `fallback`
event and `metrics.modelUsed`; when nothing works, 503." The original Portuguese text is in
`docs/prompts/0159-20261125-182843.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The reply still arrives when the primary model fails (Priority: P1)

An on-call engineer sends a message to `POST /chat` while the primary model is down, rate limited,
or rejecting requests. Today the run stops and the engineer gets a 502, in the middle of an
incident, when they need the copilot most. With this feature the operator names a second model in
the setting `OPENROUTER_MODEL_FALLBACK`. When a call to the primary model still fails after its
retries, the same call goes to the fallback model, and the run carries on and answers.

**Why this priority**: This is the value of the feature. OpsPilot runs on free OpenRouter models
that are often busy, and an on-call copilot that fails during an outage is not usable.

**Independent Test**: With a scripted fake primary model that always fails and a scripted fake
fallback model that answers, send one request and check that the reply is 200 with the fallback
model's answer.

**Acceptance Scenarios**:

1. **Given** a fallback model is set and the primary model fails every attempt of a call, **When**
   the run makes that call, **Then** the call is sent to the fallback model and the run continues
   with its answer.
2. **Given** a fallback model is set and the primary model fails once with a retryable error and
   then answers, **When** the run makes that call, **Then** the primary model answers and the
   fallback model is not called.
3. **Given** a fallback model is set, **When** one call falls back, **Then** the next call of the
   same run tries the primary model first again.
4. **Given** no fallback model is set, **When** the primary model answers, **Then** the run behaves
   exactly as it does before this feature.

---

### User Story 2 - The trace shows when and why the agent switched models (Priority: P2)

When the engineer (or the instructor in class) reads a reply, they want to know whether the
answer came from the primary model or the fallback, and why the switch happened. Every switch adds
a `fallback` event to the trace, and the reply's metrics name the model that answered.

**Why this priority**: A fallback that is invisible hides an outage of the primary model and makes
quality changes in the answers impossible to explain. It depends on User Story 1 for the switch
to happen.

**Independent Test**: With a scripted primary model that fails and a scripted fallback model that
answers, send one request and check that the trace holds one `fallback` event naming both models
and the error class, and that `metrics.modelUsed` is the fallback model's name.

**Acceptance Scenarios**:

1. **Given** one call falls back, **When** the reply is built, **Then** the trace holds one
   `fallback` event, placed before the events that the fallback model's answer produced, with the
   primary model name, the fallback model name, the name of the error that ended the primary
   attempts, and the `node` of the graph step that made the call.
2. **Given** no call falls back, **When** the reply is built, **Then** the trace holds no
   `fallback` event and `metrics.modelUsed` is the primary model's name.
3. **Given** the last model call of a run fell back, **When** the reply is built, **Then**
   `metrics.modelUsed` is the fallback model's name.
4. **Given** a call falls back, **When** the reply is built, **Then** `metrics.llmCalls` counts
   every request that call sent: each attempt on the primary model and the one on the fallback.
5. **Given** a `fallback` event, **When** it is read, **Then** it holds no text from the provider's
   error message, only the error's class name.

---

### User Story 3 - A clear 503 when no model can answer (Priority: P3)

When the primary model and the fallback both fail, or the primary fails and no fallback is set,
the engineer gets a 503 that says the model is unavailable. Today the same case returns a generic
502 "run failed", which looks like a bug in OpsPilot rather than an outage at the provider. With a
503 the engineer, and any client, can tell "try again later" apart from "something is broken".

**Why this priority**: It improves how failures read but does not make more requests succeed. It
is useful without User Stories 1 and 2, since a primary-only setup also gets the 503.

**Independent Test**: With scripted primary and fallback models that both always fail, send one
request and check that the reply is 503 with `error: "model_unavailable"`, the conversation id,
and the partial trace and metrics.

**Acceptance Scenarios**:

1. **Given** a fallback model is set and both models fail a call, **When** the reply is built,
   **Then** the status is 503, the body has `error: "model_unavailable"`, a fixed message, the
   conversation id, and, when the run returned them, the trace and metrics collected up to the
   failure.
2. **Given** no fallback model is set and the primary model fails every attempt of a call, **When**
   the reply is built, **Then** the status is 503 with `error: "model_unavailable"`.
3. **Given** a run fails for a reason other than a model call (for example the store or the
   embedding model), **When** the reply is built, **Then** the status stays 502 `run_failed`.
4. **Given** the run hits the request timeout, **When** the reply is built, **Then** the status
   stays 504 `timeout`.
5. **Given** a 503 reply, **When** it is read, **Then** the body holds no provider error text, only
   the class name of the error the primary model ended with, as the 502 reply does today.

---

### Edge Cases

- `OPENROUTER_MODEL_FALLBACK` is missing, empty, or only whitespace: no fallback is set; the app
  starts and runs with the primary model only. It is not a configuration error.
- `OPENROUTER_MODEL_FALLBACK` names the same model as `OPENROUTER_MODEL`: it is ignored, so a
  failing call is not sent twice to the same model.
- The request is aborted or times out while the primary model is being called: no retry and no
  fallback starts, and the reply is the 504 timeout as today.
- A call is a structured output call (the router, the reflection critique) or a call with tools:
  the fallback model receives the same request, with the same tools and output schema.
- The fallback model answers in a form the step cannot use (for example plain text where a forced
  tool call was required): the step handles it as it handles a bad answer from the primary model
  today; no further fallback starts.
- A run makes several model calls and only some fall back: each switch adds its own `fallback`
  event, and `metrics.modelUsed` names the model of the last call.
- The primary model fails with a client error that retrying cannot fix (for example a daily quota
  or an unsupported parameter): it is not retried, and the call goes straight to the fallback.
- History summarization runs inside the request, in the `context` step: its calls get retries and
  the fallback, and a switch there adds a `fallback` event tagged `context`. The learning reflector
  runs in the background after the reply: it gets retries and the fallback but adds no trace event,
  since its work is not part of the reply.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read an optional setting `OPENROUTER_MODEL_FALLBACK` naming the
  fallback model, alongside the existing `OPENROUTER_MODEL` and `OPENROUTER_API_KEY`.
- **FR-002**: A missing, empty, whitespace-only, or primary-equal `OPENROUTER_MODEL_FALLBACK` MUST
  mean "no fallback" and MUST NOT stop the app from starting.
- **FR-003**: Every model the single model factory builds MUST retry a failed call to the primary
  model on retryable errors (rate limits without a daily quota, server errors, timeouts of the
  call) with backoff, up to a bounded number of attempts, and MUST NOT retry on cancellation or on
  client errors that retrying cannot fix. This keeps the current retry rule.
- **FR-004**: When a fallback is set and a call to the primary model still fails after its
  retries, or fails with an error that is not retried, the system MUST send the same call to the
  fallback model, with the same messages, tools, and output schema. The fallback is retried like
  the primary, and the call never goes to a second fallback.
- **FR-005**: A cancelled call (aborted request or request timeout) MUST NOT start a retry or a
  fallback.
- **FR-006**: The switch to the fallback MUST be per call: the next call of the same run MUST try
  the primary model first.
- **FR-007**: Each call that falls back during a chat run MUST add one `fallback` event to the
  trace, before the events produced from the fallback model's answer, holding the primary model
  name, the fallback model name, the class name of the error that ended the primary attempts, and
  the `node` of the graph step that made the call.
- **FR-008**: The `fallback` event MUST NOT hold the provider's error message or any setting value
  other than the two model names.
- **FR-009**: Reply metrics MUST hold `modelUsed`, the name of the model of the last model call
  of the run that got an answer; a later call that failed on every model does not clear it. It
  MUST be present on 200 replies and on failure replies that carry metrics; when no call of the
  run got an answer, it MUST be null.
- **FR-010**: `metrics.llmCalls` MUST count every request sent to a model, retries and the
  fallback attempt included, so a call that never fails counts once, as today.
- **FR-011**: When a model call fails on every model it may use (the primary after its retries and,
  when set, the fallback), the reply MUST be HTTP 503 with `error: "model_unavailable"`, a fixed
  message, the class name of the error the primary model ended with, the conversation id, and,
  when the run returned them, the trace and metrics collected up to the failure (as the 502
  `run_failed` reply does today).
- **FR-012**: Run failures not caused by a model call MUST keep the 502 `run_failed` reply, and the
  request timeout MUST keep the 504 `timeout` reply.
- **FR-013**: Neither the 503 body nor the server log line for it MUST hold the API key; the 503
  body MUST NOT hold provider error text.
- **FR-014**: The `fallback` event and `modelUsed` MUST be validated by the reply schema at the HTTP
  boundary, like every other trace event and metric.
- **FR-015**: The model-unavailable failure MUST be a domain error class, translated to the 503 only
  at the HTTP edge.

### Key Entities

- **Fallback event**: A trace event saying one model call switched from the primary model to the
  fallback. Holds the graph node that made the call, the primary model name, the fallback model
  name, and the class name of the error that ended the primary attempts.
- **Model used**: The name of the model of the last model call of a run that got an answer,
  reported in the reply metrics; null when no call got an answer.
- **Model unavailable failure**: The outcome of a run whose model call failed on every model it may
  use. Holds the class name of the error the primary model ended with and the partial trace and
  metrics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the primary model failing every call and a working fallback set, 100% of chat
  requests that would otherwise answer get a 200 reply.
- **SC-002**: 100% of replies with at least one switch show a `fallback` event per switch, and a
  reader can tell from the reply alone which model answered.
- **SC-003**: With every model failing, 100% of chat requests get a 503 `model_unavailable` reply
  and none gets a 502.
- **SC-004**: With the primary model working, replies are unchanged apart from the new
  `modelUsed` metric: no `fallback` event, and the same number of model calls as before.
- **SC-005**: No reply, trace event, or log line produced by this feature contains the API key or
  provider error text.

## Assumptions

- The fallback model is reached through the same provider and API key as the primary model, so it
  needs no setting of its own other than its name.
- One fallback model is enough for this course project; a chain of several fallbacks is out of
  scope, though the setting may later accept a list.
- The fallback model gets the same retry as the primary (2 attempts, as the course reference
  does), so a request that fails on both models still fails within a bounded time.
- The bounded number of attempts and the backoff are chosen in the plan; the current retry rule
  (which errors are retried) is kept.
- The 503 reply carries no `Retry-After` header; clients decide when to try again.
- `arena` and `bench` keep using the factory and so get retries and the fallback too; their
  reports do not need to show the switch.
- Implementation hints from the input (`withRetry` on the primary model, `withFallbacks` with the
  fallback model, both inside the single model factory) are to be confirmed in the plan.
