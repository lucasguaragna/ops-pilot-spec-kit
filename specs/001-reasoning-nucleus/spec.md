# Feature Specification: Reasoning Nucleus

**Feature Branch**: `001-reasoning-nucleus`

**Created**: 2026-11-01

**Status**: Draft

**Input**: User description: "Núcleo de raciocínio do OpsPilot: common ReasoningStrategy interface
(name + run(input) returning answer, trace, metrics); typed trace events; single model factory in
src/agents/model.ts; mock tools in src/agents/tools.ts over a seeded store (5 services, 6 alerts:
3 firing, 3 resolved) with a seed script; MySQL through Sequelize; ReAct strategy in
src/agents/react.ts using LangGraph's prebuilt agent; Plan-and-Execute graph in
src/agents/plan-and-execute.ts with planner, executor, and replanner, limited to 8 steps; iteration
limits and LLM call counting; minimal arena in src/arena.ts with --strategies and --max-iterations;
deterministic store and trace formatting tests without network." The full original text is in
`docs/prompts/`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operate alerts and incidents through shared tools (Priority: P1)

An on-call operator's request can list alerts by status, open an incident, and resolve an incident
against a seeded set of operational data, with invalid requests rejected clearly.

**Why this priority**: Every strategy depends on these operations and data. They also work and can
be verified without any LLM provider, which is not configured yet.

**Independent Test**: Load the seed, then call each operation directly and check the stored state,
without network access.

**Acceptance Scenarios**:

1. **Given** seeded data, **When** alerts are listed as firing, **Then** exactly 3 alerts are
   returned, and listing as resolved returns the other 3.
2. **Given** seeded data, **When** an incident is opened with a title, a known service, and a valid
   severity, **Then** it is stored as open with a unique identifier.
3. **Given** an open incident, **When** it is resolved by identifier, **Then** it is stored as
   resolved.
4. **Given** invalid input, **When** any operation is called, **Then** it is rejected with a clear
   validation error and data is unchanged.
5. **Given** any prior state, **When** the seed is run, **Then** data matches the seed exactly.

---

### User Story 2 - Answer a request with the ReAct strategy (Priority: P2)

An engineer gives an operational request and the ReAct strategy reasons, uses tools, and returns an
answer with a complete trace and metrics.

**Why this priority**: It is the simplest complete path from request to auditable answer.

**Independent Test**: With a configured provider, run a request such as "list firing alerts" and
confirm the answer, trace, and metrics. Without one, confirm a clear configuration error.

**Acceptance Scenarios**:

1. **Given** seeded data, **When** the strategy handles a request, **Then** the result has an
   answer, a trace, and metrics.
2. **Given** a request that needs tools, **When** it finishes, **Then** every tool use appears in
   the trace with its tool name and arguments, followed by its observation.
3. **Given** an iteration limit, **When** the limit is reached, **Then** the run stops and reports
   that the limit ended it.

---

### User Story 3 - Answer a request with the Plan-and-Execute strategy (Priority: P3)

An engineer gives a multi-step request and the strategy builds a step list, runs one step at a time,
and revises the remaining steps after each one until nothing remains.

**Why this priority**: It adds a second reasoning pattern to compare with ReAct.

**Independent Test**: With a configured provider, run a multi-step request and confirm plan, action,
observation, and answer events appear in order.

**Acceptance Scenarios**:

1. **Given** a request, **When** the strategy starts, **Then** the trace records a plan before any
   step runs.
2. **Given** a step finishes, **When** remaining steps are reviewed, **Then** the plan is revised or
   the run ends when no steps remain.
3. **Given** a request that would need more than 8 steps, **When** 8 steps have run, **Then** the
   run stops and reports that the limit ended it.

---

### User Story 4 - Compare strategies in the arena (Priority: P4)

An engineer runs one or more strategies on the same input and reads each trace and its metrics.

**Why this priority**: Comparison is the goal of having several strategies, but it needs them first.

**Independent Test**: Run the arena with each strategy, then both, and confirm the output. Argument
errors can be checked without a provider.

**Acceptance Scenarios**:

1. **Given** several selected strategies, **When** the arena runs, **Then** each receives the same
   input and prints its answer, trace, and metrics.
2. **Given** a maximum iteration value, **When** the arena runs, **Then** every selected strategy
   respects it.
3. **Given** an unknown strategy or invalid limit, **When** the arena starts, **Then** it exits with
   a clear error before any strategy runs.

---

### Edge Cases

- Resolving an unknown incident returns a domain error, and data stays unchanged.
- Resolving an already resolved incident returns a domain error, and data stays unchanged.
- Opening an incident for an unknown service returns a domain error.
- Listing alerts with an unknown status is rejected by validation.
- Missing provider settings produce a clear configuration error that names the missing setting and
  never prints a secret value.
- If the LLM provider fails mid-run, the run ends with an error that keeps the partial trace.
- A planner that returns an empty plan ends the run with an answer and no steps executed.
- A failing strategy in the arena does not stop the remaining strategies.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All reasoning strategies MUST share one interface: a name, and a run operation that
  takes an input and returns an answer, a trace, and metrics.
- **FR-002**: A trace MUST be an ordered list of typed events: thought, action, observation, plan,
  critique, or answer. Each action event MUST carry its tool name and arguments.
- **FR-003**: Metrics MUST include the number of LLM calls and the latency in milliseconds.
- **FR-004**: All strategies MUST obtain their model from one shared factory, configured by
  `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, using the OpenRouter endpoint and temperature 0.
- **FR-005**: The system MUST provide three tools: list alerts by status, open an incident from a
  title, service, and severity, and resolve an incident by identifier.
- **FR-006**: Every tool input MUST be validated against a declared schema.
- **FR-007**: Tools MUST operate on an in-memory store that needs no external service.
- **FR-008**: The seed MUST contain 5 services and 6 alerts, with 3 firing and 3 resolved, and MUST
  be runnable through a dedicated command.
- **FR-009**: The ReAct strategy MUST use LangChain's prebuilt `createAgent` with these tools and
  capture the complete trace.
- **FR-010**: The Plan-and-Execute strategy MUST run as a graph with a planner that returns a
  structured step list, an executor that runs one step at a time with the tools, and a replanner
  that revises the remainder after each step and ends the run when nothing remains.
- **FR-011**: The Plan-and-Execute strategy MUST run at most 8 steps.
- **FR-012**: Every strategy MUST respect an iteration limit and count its LLM calls.
- **FR-013**: The arena MUST run one or more strategies on the same input and print their traces
  and metrics, selected through `--strategies` and limited through `--max-iterations`.
- **FR-014**: Store behavior and trace formatting MUST have deterministic tests that use no network.

### Key Entities

- **Service**: A monitored system; has a unique name. Alerts and incidents refer to it.
- **Alert**: A signal about a service; has an identifier, title, severity, and status of firing or
  resolved.
- **Incident**: Tracked response to a problem; has an identifier, title, service, severity, and
  status of open or resolved.
- **Trace Event**: One typed entry in a run's ordered history.
- **Run Result**: The answer, trace, and metrics of one strategy run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After seeding, 100% of runs show exactly 5 services, 3 firing alerts, and 3 resolved
  alerts.
- **SC-002**: Store and trace formatting tests pass with network access disabled and give the same
  result on 100% of repeated runs.
- **SC-003**: For every tool use in a run, an engineer can read its tool, arguments, and result in
  the printed trace.
- **SC-004**: No run exceeds its iteration limit, and no Plan-and-Execute run exceeds 8 steps.
- **SC-005**: An engineer can compare 2 strategies on one input with a single command.
- **SC-006**: Reported LLM calls match the calls actually made on 100% of runs checked with a fake
  model.

## Assumptions

- `IllCalls` in the request means `llmCalls`, and "rools" means "tools".
- The request named LangGraph's prebuilt ReAct agent. The user chose `createAgent` instead, because
  `createReactAgent` is deprecated.
- OpenRouter credentials arrive in the next course class. Until then, only strategy runs that need a
  provider cannot be verified end to end.
- MySQL through Sequelize is deferred to a later feature, as chosen by the user. This feature adds
  no database connection.
- The seed resets data to a known state each time it runs. Data lives only for one process, so the
  seed command loads it and prints a summary, and each arena run starts from the seed.
- Service names and alert content are fictional sample data.
- Severity values are low, medium, high, and critical.
- The default iteration limit is 10 when `--max-iterations` is not given, and the arena runs all
  strategies when `--strategies` is not given.
- The Reflection strategy, HTTP API, and bench are out of scope, although the trace reserves the
  critique event for later use.
- The seed command is built during implementation, so it runs at the end of `/speckit-implement`.
