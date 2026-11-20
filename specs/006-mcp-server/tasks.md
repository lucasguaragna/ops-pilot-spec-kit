---

description: "Task list for the OpsPilot MCP Server feature"
---

# Tasks: OpsPilot MCP Server

**Input**: Design documents from `specs/006-mcp-server/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/mcp-server.md](contracts/mcp-server.md),
[quickstart.md](quickstart.md)

**Tests**: Requested. The request asks for a test that starts the server and validates the tool
list (FR-013), and the constitution says new logic ships with a test. Within each phase, the test
task comes first and must fail before the implementation task.

**Organization**: Tasks are grouped by user story, so each story can be built and checked on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1 to US3)
- Every description names the exact file path

## Path Conventions

Single project. Source in `src/`, tests next to the code as `*.test.ts`, run with `node:test`
through `tsx`. Gates: `npm run typecheck` and `npm test`. No test may touch `data/` or the
configured `OPSPILOT_DB`: use `new SqliteOpsStore(":memory:")` in process, `OPSPILOT_DB=":memory:"`
for a spawned server, or a fresh OS temp directory that the test removes.

---

## Phase 1: Setup

**Purpose**: Green baseline, the new dependency and the npm script.

- [X] T001 Run `npm run typecheck` and `npm test` from the repository root and confirm both pass
  before any change, so later failures belong to this feature.
- [X] T002 Add the dependency with `npm install @modelcontextprotocol/sdk@^1.32.2`, which updates
  `package.json` and `package-lock.json`. Confirm `npm ls zod` shows one `zod` 4 (the SDK's peer
  accepts `^3.25 || ^4.0`, so no second copy is installed).
- [X] T003 Add the script `"mcp": "node --env-file-if-exists=.env --import tsx src/mcp/server.ts"`
  to `package.json`, next to `dev`, `arena` and `bench` (research R8). Do not read `.env`.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: The single source of truth for tool names, descriptions, schemas and store operations
(research R2, R3). Both edges depend on it, so no user story can start before this phase is done.

- [X] T004 Write `src/tools/definitions.test.ts` (fails until T005). Cover:
  - exactly six definitions, names `list_alerts`, `open_incident`, `resolve_incident`,
    `list_incidents`, `get_runbook`, `check_provider_status`, all unique;
  - each `schema` is the same object (`assert.strictEqual`) as the export in
    `src/domain/schemas.ts`: `ListAlertsInput`, `OpenIncidentInput`, `ResolveIncidentInput`,
    `ListIncidentsInput`, `GetRunbookInput`, `CheckProviderStatusInput`;
  - each `description` is a non-empty string;
  - the five store definitions have `run`, and `check_provider_status` has none;
  - `run` on a `new SqliteOpsStore(":memory:")` calls the matching store method (for example
    `list_alerts.run(store, { status: "firing" })` deep-equals `store.listAlerts("firing")`);
  - `runToolText(() => value)` returns `{ text: JSON.stringify(value), isError: false }`;
  - `runToolText` with an action that throws a `DomainError` subclass returns
    `{ text: "Error: <message>", isError: true }`;
  - `runToolText` with an action that throws a plain `Error` re-throws it.
- [X] T005 Create `src/tools/definitions.ts` (data-model "ToolDefinition" and "ToolOutcome").
  - Export `type ToolOutcome = { text: string; isError: boolean }` and
    `runToolText(action: () => unknown): ToolOutcome`: success gives `JSON.stringify(result)` with
    `isError: false`; a `DomainError` gives `` `Error: ${message}` `` with `isError: true`; anything
    else is re-thrown.
  - Export one definition per tool with fields `name` (string literal, "snake_case, unique across
    all definitions"), `description` (moved verbatim from today's `createTools` in
    `src/agents/tools.ts`), `schema` (the existing zod object from `src/domain/schemas.ts`, "by
    reference, never copied") and, for the five store tools, `run(store: OpsStore, input)` with the
    single store call from the data-model table (`store.listAlerts(status)`,
    `store.openIncident(input)`, `store.resolveIncident({ id, summary })`,
    `store.listIncidents(status)`, `store.getRunbook(service)`).
  - Type each definition so `input` in `run` is `z.output<typeof schema>`.
  - No LangChain and no MCP SDK import in this file.
- [X] T006 Extend `src/agents/tools.test.ts` (fails until T007): for each of the six tools returned
  by `createTools`, assert `name` and `description` equal the definition's and `schema` is the same
  object (`assert.strictEqual`) as the definition's `schema` (research R6, agent side). Keep every
  existing test unchanged.
- [X] T007 Rewire `createTools` in `src/agents/tools.ts` to build every tool from
  `src/tools/definitions.ts`: `name`, `description` and `schema` from the definition, and the
  handler `async (input) => runToolText(() => def.run(store, input)).text` for the five store tools.
  `check_provider_status` takes `name`, `description` and `schema` from its definition but keeps its
  own `deps`-based handler as today. Delete `toToolText`. The returned strings must be identical to
  before, so the existing tests in `src/agents/tools.test.ts` pass unchanged.
- [X] T008 Run `npm run typecheck` and `npm test`; both green. `src/index.ts`, `src/arena.ts` and
  `src/bench.ts` still call `createTools(store)` with no change.

**Checkpoint**: One definition per tool, read by the agent. The MCP edge can now be built on it.

---

## Phase 3: User Story 1 - Discover OpsPilot's operations from any MCP client (Priority: P1) 🎯 MVP

**Goal**: A client that starts `opspilot` over stdio sees exactly `list_alerts`, `open_incident`
and `resolve_incident`, each with the agent's description and input contract.

**Independent Test**: Spawn `src/mcp/server.ts` with `OPSPILOT_DB=":memory:"`, connect with
`StdioClientTransport`, list the tools, and check the three names, descriptions and schemas
(spec US1 scenarios 1 to 4, SC-001, SC-002).

### Tests for User Story 1

- [X] T009 [P] [US1] Write `src/mcp/create-server.test.ts` (fails until T010). Link a `Client`
  (`@modelcontextprotocol/sdk/client/index.js`) to `createMcpServer(new SqliteOpsStore(":memory:"))`
  with `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`). Assert:
  - `client.getServerVersion()` has `name: "opspilot"` and `version` equal to `version` in
    `package.json`;
  - `listTools()` returns exactly `["list_alerts", "open_incident", "resolve_incident"]`, in that
    order;
  - for each listed tool, `description === definition.description`, and `inputSchema.properties`
    and `inputSchema.required` deep-equal those of
    `z.toJSONSchema(definition.schema, { io: "input" })` (research R6; compare against the zod
    source, not a snapshot, so SC-003 holds). Treat a missing `required` as `[]` on both sides.
- [X] T010 [P] [US1] Write the spawned test in `src/mcp/server.test.ts` (fails until T012; this is
  the test FR-013 asks for). Use `StdioClientTransport` with `command: process.execPath`,
  `args: ["--import", "tsx", "src/mcp/server.ts"]`, `cwd` the repository root,
  `env: { ...process.env, OPSPILOT_DB: ":memory:" }` and `stderr: "pipe"`. Connect a `Client`,
  assert `listTools()` names are exactly the three, then `client.close()`. Set a test timeout (for
  example 20 s) so a hung child fails the test instead of the run.

### Implementation for User Story 1

- [X] T011 [US1] Create `src/mcp/create-server.ts` exporting
  `MCP_TOOL_NAMES = ["list_alerts", "open_incident", "resolve_incident"] as const` and
  `createMcpServer(store: OpsStore, options?: { logError?: (line: string) => void }): McpServer`
  (data-model "Server identity": name `opspilot`, version from `package.json`, `tools` capability
  only). For each name, look up the definition in `src/tools/definitions.ts` and call
  `server.registerTool(def.name, { description: def.description, inputSchema: def.schema }, handler)`
  passing the shared `z.object` itself (research R5). The handler returns
  `{ content: [{ type: "text", text }], isError }` from `runToolText(() => def.run(store, input))`.
  No LangChain import, no `console.log`, no `process.stdout`.
- [X] T012 [US1] Create the entry point `src/mcp/server.ts` (research R7, R9; contract "Streams and
  exit"):
  1. First statement: `console.log = console.info = console.debug = console.error`, so a
     dependency that logs cannot corrupt stdout.
  2. Open the store with `openOpsStore()` from `src/store/`.
  3. `createMcpServer(store, { logError: (line) => console.error(line) })`, then
     `await server.connect(new StdioServerTransport())`.
  4. Write `opspilot: ready (db: <path>)` to stderr, where `<path>` is the resolved database path
     (blank or unset `OPSPILOT_DB` means `./data/opspilot.db`). Never print other env values.
  5. One idempotent `shutdown(code)`: on the first call write `opspilot: shutting down` to stderr,
     `await server.close()`, `store.close()`, then `process.exit(code)`; later calls do nothing.
     Wire it to `process.stdin` `end`, the transport's `onclose`, `SIGINT` and `SIGTERM`, all with
     code 0.
- [X] T013 [US1] Run `npm test`: T009 and T010 pass.

**Checkpoint**: MVP. `opspilot` starts, and any MCP client lists the three tools.

---

## Phase 4: User Story 2 - Work alerts and incidents from the MCP client (Priority: P1)

**Goal**: Each call performs the agent's store operation and returns the agent's text. Domain
errors, invalid input and unexpected failures come back as error results, and the server keeps
running.

**Independent Test**: With the in-process client from T009, call `list_alerts`, `open_incident`
and `resolve_incident` in order on a fresh `":memory:"` store and compare each result with the
agent's text for the same input and state (spec US2 scenarios 1 to 5).

### Tests for User Story 2

- [X] T014 [US2] Add call tests to `src/mcp/create-server.test.ts` (same file as T009, so not
  [P]). Fresh store and client per test. Assert:
  - `list_alerts` with `{}` returns one text item equal to
    `runToolText(() => store.listAlerts("firing")).text`, with `isError` falsy (the default applies);
  - `open_incident` with a title, a service taken from `store.listAlerts("firing")` and severity
    `"high"` returns JSON whose `id` matches `/^INC-\d{3}$/`, and `store.listIncidents("open")`
    contains it;
  - `resolve_incident` with that id and a summary returns JSON with `resolvedAt` and that summary;
  - unknown service, unknown incident id, and an already resolved incident each return
    `isError: true` with text equal to the agent's `Error: <message>` for the same call;
  - invalid input (severity `"urgent"`; missing `title`) returns an error result, and
    `store.listIncidents("all")` is unchanged (FR-007). Assert "rejected and store unchanged", not
    the SDK's exact wording;
  - calling `get_runbook` is rejected as an unknown tool (protocol error or error result naming the
    tool);
  - unexpected failure: a store stub whose `listAlerts` throws `new Error("boom")` gives
    `{ isError: true, content: [{ type: "text", text: "Error: internal error" }] }`, the `logError`
    spy received `opspilot: list_alerts failed: boom`, and a following `listTools()` still works.

### Implementation for User Story 2

- [X] T015 [US2] In the handler in `src/mcp/create-server.ts`, catch any error that `runToolText`
  re-throws: call `logError(`opspilot: ${def.name} failed: ${message}`)` and return
  `{ isError: true, content: [{ type: "text", text: "Error: internal error" }] }` (research R4).
  Default `logError` writes to stderr with `console.error`. Domain errors keep the
  `runToolText` text. Do not catch inside `runToolText`.
- [X] T016 [US2] Run `npm test`: T014 passes and T009 still passes.

**Checkpoint**: The three tools behave exactly as the agent's tools, through MCP.

---

## Phase 5: User Story 3 - The protocol channel stays clean (Priority: P2)

**Goal**: stdout carries JSON-RPC only. Ready, shutdown and failure messages go to stderr. A store
that cannot be opened ends the process with exit 1 and an empty stdout.

**Independent Test**: Spawn the server, run a full session, and check every stdout line is
JSON-RPC 2.0; spawn it with an unopenable database and check exit 1, empty stdout, and a reason on
stderr (spec US3 scenarios 1 to 3, SC-004).

### Tests for User Story 3

- [X] T017 [US3] Add a raw-session test to `src/mcp/server.test.ts`. Spawn with
  `node:child_process` `spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"])`, env
  `OPSPILOT_DB=":memory:"`, and write newline-delimited JSON-RPC to stdin: `initialize`,
  `notifications/initialized`, `tools/list`, `tools/call` for `list_alerts`. After the
  `tools/call` response arrives, end stdin. Assert:
  - every non-empty stdout line parses as JSON with `jsonrpc: "2.0"` (SC-004);
  - the process exits with code 0 after stdin ends (FR-012);
  - stderr contains `opspilot: ready` and `opspilot: shutting down`.
- [X] T018 [US3] Add a startup failure test to `src/mcp/server.test.ts`. In a fresh
  `fs.mkdtemp(os.tmpdir())` directory write a regular file `blocker`, then spawn the server with
  `OPSPILOT_DB=<tmp>/blocker/x.db` so the store cannot create its directory. Assert exit code 1,
  stdout is empty, and stderr is non-empty. Remove the temp directory in `finally`.
- [X] T019 [US3] Add a source guard test to `src/mcp/server.test.ts`: read every `src/mcp/*.ts`
  file that is not `*.test.ts` and fail if it matches `/console\.(log|info|debug)\(/` or
  `/process\.stdout\.write/`. The remap assignment in `server.ts` (`console.log = ...`) does not
  match because it has no `(`.

### Implementation for User Story 3

- [X] T020 [US3] In `src/mcp/server.ts`, wrap the store opening: on `StoreOpenError` write
  `opspilot: <error message>` to stderr and `process.exit(1)` before any transport is created, so
  nothing reaches stdout (FR-010). Any other startup error does the same with exit 1. Keep the
  console remap as the first statement.
- [X] T021 [US3] Run `npm test`: T017, T018 and T019 pass.

**Checkpoint**: All three stories work and are covered by tests.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T022 [P] Create `.mcp.json` at the repository root with exactly the JSON from
  [contracts/mcp-server.md](contracts/mcp-server.md) "Claude Code registration": server `opspilot`,
  `command: "npm"`, `args: ["run", "--silent", "mcp"]`. No secret and no `env` block.
- [X] T023 [P] Add the line "`npm run mcp`: start the `opspilot` MCP server over stdio" to the
  Commands list in `CLAUDE.md`.
- [X] T024 Run `npm run typecheck` and `npm test` from the repository root; both green (SC-007).
- [ ] T025 Manual check (by the user): follow [quickstart.md](quickstart.md) sections 2, 3 and 5:
  the Inspector lists three tools, Claude Code `/mcp` shows `opspilot` connected with 3 tools
  (SC-005), and `OPSPILOT_DB=/dev/null/x.db npm run --silent mcp` prints a reason, `exit 1` and an
  empty `out.txt`.

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (Phase 1): no dependency.
- Foundational (Phase 2): needs only T001 (it uses no MCP SDK). Blocks every story.
- US1 (Phase 3): needs Phase 2 and T002, T003 (the spawned test runs the script's command).
- US2 (Phase 4): needs T011 (the handler it extends) and T009 (same test file and client setup).
- US3 (Phase 5): needs T012 (the entry point it hardens). Independent of US2.
- Polish (Phase 6): after the stories you ship.

### Within each phase

- The test task comes before its implementation task and must fail first.
- T004 before T005; T006 before T007; T009 and T010 before T011 and T012; T014 before T015;
  T017 to T019 before T020.
- Tasks that edit the same file are never [P]: `src/mcp/create-server.test.ts` (T009, T014),
  `src/mcp/server.test.ts` (T010, T017, T018, T019), `src/mcp/server.ts` (T012, T020).

### Parallel opportunities

- Phase 2: T004 and T006 are different files and can be written together.
- Phase 3: T009 and T010 together.
- After T012: US2 (T014, T015) and US3 (T017 to T020) touch different files and can run in
  parallel.
- Phase 6: T022 and T023 together.

## Parallel Example: User Story 1

```text
Task: "T009 [US1] In-process list test in src/mcp/create-server.test.ts"
Task: "T010 [US1] Spawned list test in src/mcp/server.test.ts"
```

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 and Phase 2: shared definitions, agent rewired, still green.
2. Phase 3: the server starts and lists three tools.
3. Stop and validate: `npm test`, then the Inspector (quickstart section 2).

### Incremental delivery

1. Setup and Foundational: one source of truth, no behaviour change.
2. US1: discovery works (MVP).
3. US2: calls, errors and validation match the agent.
4. US3: stdout guard, startup failure, clean shutdown verified.
5. Polish: `.mcp.json`, `CLAUDE.md`, final gates, manual check.

## Notes

- `docs/code-examples/mcp-server.ts` is the instructor's reference sketch. Leave it untouched and
  do not import from it (research R1).
- `new SqliteOpsStore(":memory:")` seeds services, alerts and runbooks on construction, so
  `list_alerts` returns firing alerts in every test without extra setup.
- Mark each task `[X]` in this file as it is completed.
