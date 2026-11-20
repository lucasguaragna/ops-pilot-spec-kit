# Feature Specification: OpsPilot MCP Server

**Feature Branch**: `006-mcp-server`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "OpsPilot MCP server: src/mcp/server.ts. @modelcontextprotocol/sdk,
stdio transport, exposing list_alerts, open_incident and resolve_incident, reusing the same
OpsStore and the same zod schemas as the existing tools (a single source of truth). Server name:
opspilot. npm script: mcp = \"tsx src/mcp/server.ts\" (if environment variables are needed, change
the script and load them first). CRITICAL RULE: no console.log in the server; over stdio, stdout is
the protocol channel, and diagnostics go to stderr. Test: start the server and validate the tool
list." The original Portuguese text is in `docs/prompts/0094-20261120-125614.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover OpsPilot's operations from any MCP client (Priority: P1)

An engineer adds OpsPilot to an MCP-capable assistant (Claude Code, an IDE agent, a desktop
client) as a local server named `opspilot`. When the client connects, it lists the available tools
and sees exactly `list_alerts`, `open_incident` and `resolve_incident`, each with the same
description and input contract the OpsPilot agent already uses.

**Why this priority**: Discovery is the precondition for everything else. If the client cannot
connect and list the tools, nothing else in the feature is usable. It is also the behaviour the
request asks the test to cover.

**Independent Test**: Start the server as a child process, connect a client over its standard
input and output, request the tool list, and check that it holds exactly the three names, each with
a description and an input contract matching the agent's tool of the same name.

**Acceptance Scenarios**:

1. **Given** the server is started, **When** a client connects and asks who it is, **Then** the
   server identifies itself as `opspilot`.
2. **Given** a connected client, **When** it lists the tools, **Then** it receives exactly
   `list_alerts`, `open_incident` and `resolve_incident`, and no other tool.
3. **Given** a connected client, **When** it reads the input contract of each tool, **Then** the
   fields, allowed values, defaults, required flags and field descriptions are the same as those of
   the agent's tool with the same name.
4. **Given** a connected client, **When** it reads a tool's description, **Then** the text is the
   same as the agent's tool with the same name.

---

### User Story 2 - Work alerts and incidents from the MCP client (Priority: P1)

From the MCP client, the engineer asks what is firing, opens an incident for a service, and later
resolves it. Each call reads or changes the same alerts and incidents that the OpsPilot HTTP
endpoint works with, so both entry points always see one consistent state.

**Why this priority**: Listing tools has no value unless calling them does the same thing the
agent's tools do. Sharing one data source is the point of the "single source of truth" rule.

**Independent Test**: Connect a client to a server backed by a fresh store, call `list_alerts`,
`open_incident` and `resolve_incident` in order, and check that each result matches what the
agent's tool returns for the same input and state.

**Acceptance Scenarios**:

1. **Given** a store with firing alerts, **When** the client calls `list_alerts` with no
   arguments, **Then** it receives the firing alerts, the same as the agent's tool returns.
2. **Given** a known service, **When** the client calls `open_incident` with a title, that service
   and a severity, **Then** it receives the new incident with an `INC-NNN` id, and that incident is
   visible to the HTTP endpoint afterwards.
3. **Given** an open incident, **When** the client calls `resolve_incident` with its id and an
   optional summary, **Then** it receives the resolved incident with its resolution time and
   summary.
4. **Given** an unknown service, an unknown incident id, or an already resolved incident, **When**
   the client calls the matching tool, **Then** it receives an error result carrying the same
   readable message the agent's tool gives, and the server keeps running.
5. **Given** input that breaks the contract (missing field, severity outside the allowed values),
   **When** the client calls the tool, **Then** the call is rejected with a validation error, the
   store is not changed, and the server keeps running.

---

### User Story 3 - The protocol channel stays clean (Priority: P2)

The server talks to its client over its standard output. Anything else written there (a startup
banner, a debug line, a warning) corrupts the conversation and the client drops the connection.
The engineer can still see what the server is doing, because every diagnostic goes to the error
stream instead.

**Why this priority**: A single stray line breaks the server in a way that is hard to diagnose
from the client side. It is a rule the code has to keep forever, so it needs its own check.

**Independent Test**: Start the server, complete a session (connect, list tools, call a tool, shut
down) and check that every line the server wrote to standard output is a valid protocol message,
and that any startup or failure message appeared on the error stream.

**Acceptance Scenarios**:

1. **Given** the server starts normally, **When** it is ready, **Then** any ready message goes to
   the error stream and nothing but protocol messages ever goes to standard output.
2. **Given** the database cannot be opened, **When** the server starts, **Then** it writes a
   readable reason to the error stream, writes nothing to standard output, and exits with a non-zero
   status.
3. **Given** the server source code, **When** it is checked, **Then** it contains no writes to
   standard output other than through the protocol transport.

---

### Edge Cases

- The client closes its end of the connection: the server shuts down cleanly and releases the
  database.
- The database file path setting is missing or blank: the server uses the same default as the HTTP
  app.
- The database file is locked or unreadable: the server reports it on the error stream and exits
  with a non-zero status (User Story 3, scenario 2).
- The HTTP endpoint and the MCP server run at the same time against the same database file: both
  see each other's changes, as two processes sharing the store already do.
- The client calls a tool that is not exposed (for example `get_runbook`): the server answers with
  a protocol error saying the tool is unknown.
- An unexpected (non-domain) failure inside a tool: it is reported to the client as an error
  result, written to the error stream, and does not stop the server.
- The server is launched through the package script runner: the runner must not add banner lines
  to standard output, or the client must launch it in a way that suppresses them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a local MCP server named `opspilot` that a client starts as
  a child process and talks to over the child's standard input and output.
- **FR-002**: The server MUST expose exactly three tools, `list_alerts`, `open_incident` and
  `resolve_incident`, and no others.
- **FR-003**: Each exposed tool MUST use the same input contract (fields, allowed values, defaults,
  required flags and field descriptions) as the agent's tool of the same name, taken from the one
  shared definition, never from a copy.
- **FR-004**: Each exposed tool's name and description MUST come from the same single definition
  the agent's tools use, so changing it in one place changes both entry points.
- **FR-005**: Each tool call MUST perform the same store operation as the agent's tool of the same
  name and return the same result content.
- **FR-006**: The server MUST open the same store, at the same database location setting and with
  the same default, as the HTTP app; tests MUST be able to give it an in-memory store instead.
- **FR-007**: Input that breaks a tool's contract MUST be rejected before any store operation runs.
- **FR-008**: A domain error (unknown service, unknown incident, incident already resolved) MUST be
  returned to the client as an error result with the same readable message the agent's tool gives;
  it MUST NOT stop the server.
- **FR-009**: The server MUST NOT write anything to standard output except protocol messages. All
  diagnostics (ready, shutdown, failures) MUST go to the error stream.
- **FR-010**: When the store cannot be opened at startup, the server MUST write a readable reason to
  the error stream and exit with a non-zero status, without writing to standard output.
- **FR-011**: The project MUST provide a package script `mcp` that starts the server. If the server
  needs settings from the local environment file, the script MUST load them before the server
  starts, the same way the other entry points do, without agents reading that file.
- **FR-012**: The server MUST shut down cleanly and close the store when the client disconnects or
  the process receives a termination signal.
- **FR-013**: An automated test MUST start the server, connect a client over standard input and
  output, list the tools, and verify the three names and their contracts; it MUST NOT touch the
  database at the configured location or under `data/`.

### Key Entities

- **MCP server `opspilot`**: The new entry point. It owns no data; it adapts the shared tool
  definitions to the protocol and forwards calls to the store.
- **Tool definition**: Name, description and input contract of one operation. Today it lives with
  the agent's tools; after this feature both the agent and the MCP server read it from one place.
- **Ops store**: The existing source of alerts and incidents, shared by the HTTP app, the bench and
  now the MCP server.
- **Alert / Incident**: Existing domain records, unchanged by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client that connects to the server lists exactly 3 tools, with the names
  `list_alerts`, `open_incident` and `resolve_incident`, in 100% of test runs.
- **SC-002**: For each of the 3 tools, the contract and description seen by an MCP client match the
  agent's tool with no differences.
- **SC-003**: Changing a shared tool description or field description in one place changes what
  both the agent and an MCP client see, with no second edit.
- **SC-004**: Over a full test session, 100% of the lines on the server's standard output are valid
  protocol messages.
- **SC-005**: An engineer can register the server in an MCP client and list its tools in under
  2 minutes, following the quickstart.
- **SC-006**: An incident opened from the MCP client is visible from the HTTP endpoint without a
  restart, and the reverse.
- **SC-007**: The existing type check and test suite stay green.

## Assumptions

- Scope is the three named tools. `list_incidents`, `get_runbook` and `check_provider_status` are
  not exposed in this feature, even though `resolve_incident` users usually need an id from
  `list_incidents`; adding them later is a small follow-up.
- The MCP SDK named in the request is an added dependency for a new entry point; it does not
  replace any part of the constitution's stack, so no amendment is needed.
- The server needs only the database location setting; it needs no model or API key, because it
  never calls the LLM.
- To match the other entry points, the `mcp` script loads the local environment file when it
  exists, so a custom database location set there is honoured; the plan may simplify this if no
  setting is needed.
- The MCP server is a CLI-style edge in the layered design: it validates input with the shared
  contracts, translates domain errors into error results, and keeps side effects at the edge, as
  the HTTP controller does.
- Tool results keep the same content shape as the agent's tools (the JSON text of the store
  result, or the `Error: ...` text), so an assistant reading them gets the same information either
  way.
- Only local use over standard input and output is in scope. Network transports, authentication
  and multi-user access are out of scope.
- The test runs the server against an in-memory store, as the constitution's persistence rules
  require.
