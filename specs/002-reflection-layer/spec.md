# Feature Specification: Reflection Layer

**Feature Branch**: `002-reflection-layer`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Reflection layer: withReflection(strategy, opts) decorates any
ReasoningStrategy. It runs the base strategy; a critic (same model, structured output
{approved, feedback}) checks the answer against the trace observations; if it rejects, the answer is
regenerated with the feedback in context; it stops on approved or maxReflections (default 2).
'critique' event in the trace; metrics add up the extra layers. Arena: reflect:react and
reflect:plan-execute." The original Portuguese text is in `docs/prompts/`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Catch an answer the trace does not support (Priority: P1)

An engineer runs a strategy with reflection. After the base strategy answers, a critic compares the
answer with what the tools actually returned, and records whether it approves and why.

**Why this priority**: The previous feature showed a run that claimed an incident was resolved when
no tool had resolved it. Checking the answer against the observations is the core value.

**Independent Test**: With a fake model, give the critic an answer that contradicts an observation
and confirm a rejecting critique appears in the trace with its feedback.

**Acceptance Scenarios**:

1. **Given** a completed base run, **When** reflection runs, **Then** the trace records one critique
   after the base run's events, stating whether the answer was approved and the feedback.
2. **Given** an answer that every observation supports, **When** the critic approves it, **Then**
   the run ends with that answer and no further attempt.
3. **Given** a base run that stopped by limit or error, **When** reflection runs, **Then** no
   critique is made and the base result is returned unchanged.

---

### User Story 2 - Regenerate a rejected answer with the feedback (Priority: P2)

When the critic rejects an answer, the request is attempted again with the critic's feedback in
context, until the critic approves or the reflection limit is reached.

**Why this priority**: Detecting a bad answer is useful alone; fixing it is the next step.

**Independent Test**: With a fake model, script a rejection then an approval, and confirm two
attempts, two critiques, and the second answer as the result.

**Acceptance Scenarios**:

1. **Given** a rejected answer, **When** reflections remain, **Then** a new attempt runs with the
   original request plus the feedback, and its answer is critiqued in turn.
2. **Given** every answer is rejected, **When** the reflection limit is reached, **Then** the run
   ends with the last answer, and the trace shows the last critique as rejected.
3. **Given** no limit is set, **When** reflection runs, **Then** at most 2 regenerations happen.
4. **Given** a rejection because an action the request asked for is missing or wrong, **When** the
   new attempt runs, **Then** the base strategy runs again with the request, the feedback, and the
   actions already taken, and is told not to repeat them.
5. **Given** a rejection because only the answer text is wrong, such as a claim no observation
   supports, **When** the new attempt runs, **Then** the answer is rewritten from the existing
   observations and the feedback in one model call, with no tools.

---

### User Story 3 - Compare reflected strategies in the arena (Priority: P3)

An engineer selects `reflect:react` or `reflect:plan-execute` in the arena, next to the plain
strategies, and compares traces and metrics.

**Why this priority**: It shows what reflection costs and what it fixes, but needs the layer first.

**Independent Test**: Parse arena flags with the new names without a provider; run them with one.

**Acceptance Scenarios**:

1. **Given** `--strategies reflect:react,react`, **When** the arena runs, **Then** both run on the
   same input and print their traces and metrics.
2. **Given** a reflected strategy, **When** its metrics print, **Then** LLM calls include every base
   attempt and every critique, and latency covers the whole run.

---

### Edge Cases

- The critic's reply lacks the structured verdict: it is retried once; if it still fails, or the
  rewrite call fails, the run keeps the last answer with stop reason completed and notes the
  skipped reflection in the trace.
- A regeneration stops by limit or error: the run ends with that stop reason, keeping every earlier
  attempt and critique in the trace.
- The base answer is empty: the critic still judges it, and an empty answer is not supported by any
  observation.
- A reflection limit of 0: the base answer is critiqued once and never regenerated.
- A rejection without a fix kind counts as a missing verdict and is retried like one.
- A rerun may still repeat an action if the model ignores the instruction; the trace shows every
  action, so a duplicate is visible.
- A negative or non-integer reflection limit is rejected before any run.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The reflection layer MUST wrap any reasoning strategy and present the same strategy
  interface, so it can be used wherever a strategy is used.
- **FR-002**: The reflected strategy's name MUST be `reflect:` followed by the base strategy's name.
- **FR-003**: After a completed attempt, a critic MUST judge the answer against the request and the
  attempt's observations, and return whether it approves, written feedback, and, when it rejects,
  the kind of fix: rerun (an action is missing or wrong) or rewrite (only the answer text is wrong).
- **FR-004**: The critic MUST use the same model as the strategies.
- **FR-005**: Each critique MUST appear in the trace as a critique event that states approval and
  the feedback, placed right after the attempt it judges.
- **FR-006**: A rejected answer MUST lead to a new attempt with the feedback in context, while
  regenerations remain. A rerun runs the base strategy again with the request, the feedback, and
  the actions already taken, with an instruction not to repeat them. A rewrite makes one model call
  without tools over the observations gathered so far and the feedback.
- **FR-007**: The number of regenerations MUST NOT exceed the reflection limit, which defaults to 2.
- **FR-008**: The run MUST end when the critic approves, when the limit is reached, or when an
  attempt stops by limit or error.
- **FR-009**: Metrics MUST add the LLM calls of every attempt and every critique, and latency MUST
  cover the whole run.
- **FR-010**: The trace MUST hold every attempt's events in order, each attempt followed by its
  critique.
- **FR-011**: The arena MUST accept `reflect:react` and `reflect:plan-execute` as strategy names.
- **FR-012**: The reflection loop MUST have deterministic tests with a fake model and no network.

### Key Entities

- **Critique**: The critic's verdict on one answer: approved or not, feedback, and the fix kind when
  rejected.
- **Attempt**: The base run, a rerun, or a rewrite, and its result.
- **Reflected Run Result**: The final answer, the combined trace of all attempts and critiques, and
  the summed metrics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In fake-model tests, 100% of answers that contradict an observation get a rejecting
  critique when the critic is scripted to reject.
- **SC-002**: No reflected run makes more than 1 + the reflection limit attempts.
- **SC-003**: Reported LLM calls equal the calls actually made on 100% of fake-model runs.
- **SC-004**: An engineer can compare a strategy with and without reflection in one arena command.
- **SC-005**: For every critique, an engineer can read the verdict and feedback in the printed trace.

## Assumptions

- The critic sees the request, the answer, and the observations gathered so far. It does not call
  tools.
- The user asked for a verdict of `{approved, feedback}`. The fix kind was added when the user chose
  to pick between rerun and rewrite per rejection.
- A run that ends at the limit with a rejected answer keeps stop reason `completed`; the last
  critique in the trace shows the rejection.
- The iteration limit applies to each attempt separately, not to the reflected run as a whole.
- The arena gets no new flag for the reflection limit; it uses the default of 2.
- `reflect:` can wrap any registered strategy, but the arena exposes only the two named ones.
