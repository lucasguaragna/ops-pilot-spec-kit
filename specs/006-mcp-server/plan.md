# Implementation Plan: OpsPilot MCP Server

**Branch**: `006-mcp-server` (name only; work is on `main`) | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-mcp-server/spec.md`, plus the unfinished reference
sketch `docs/code-examples/mcp-server.ts`

## Summary

A local MCP server named `opspilot` exposes `list_alerts`, `open_incident` and `resolve_incident`
over stdio, backed by the same SQLite `OpsStore` as the HTTP app.

- **Single source of truth**: a new module `src/tools/definitions.ts` holds, for every tool, its
  name, description, zod input schema and (for store tools) the store operation. The LangChain
  tools in `src/agents/tools.ts` and the MCP server both read from it. Today's inline names and
  descriptions move there unchanged.
- **One outcome function**: `runToolText(action)` replaces `toToolText`. It returns a value,
  `{ text, isError }`, instead of throwing for domain errors. The agent returns `text`; MCP maps
  `isError` to the protocol's `isError: true`. Non-domain errors still throw, as today.
- **Server builder**: `createMcpServer(store)` in `src/mcp/create-server.ts` registers the three
  definitions with `McpServer.registerTool`, passing the shared `z.object` schema itself as
  `inputSchema` (SDK 1.32 accepts a full zod v4 object). It has no side effects, so tests drive it
  in process.
- **Entry point**: `src/mcp/server.ts` opens the store with `openOpsStore()`, connects
  `StdioServerTransport`, writes diagnostics only to stderr, and closes the store on stdin end,
  transport close, `SIGINT` or `SIGTERM`. A store open failure prints the reason to stderr and
  exits 1.
- **Script**: `"mcp": "node --env-file-if-exists=.env --import tsx src/mcp/server.ts"`, the same
  shape as `dev`, `arena` and `bench`, so `OPSPILOT_DB` from `.env` is honoured.
- **Reference sketch**: kept its shape (`McpServer`, `StdioServerTransport`, `registerTool`) but
  not its inline schema, which duplicates and contradicts the domain contract (see
  [research.md](research.md) R1).

## Technical Context

**Language/Version**: TypeScript 7, ESM, `strict: true`, on Node.js 22.13+

**Primary Dependencies**:

- New: `@modelcontextprotocol/sdk` `^1.32.2` (server `McpServer`, `StdioServerTransport`; client
  `Client`, `StdioClientTransport`, `InMemoryTransport` for tests). Its `zod` peer accepts
  `^3.25 || ^4.0`, so the project's `zod` 4 is reused, not duplicated.
- Existing: `zod` 4, `@langchain/core` 1.3 (`tool`), `node:sqlite` via `SqliteOpsStore`.

**Storage**: The existing SQLite store, opened by `openOpsStore()` from `OPSPILOT_DB` (default
`./data/opspilot.db`). Tests use `new SqliteOpsStore(":memory:")` in process, or
`OPSPILOT_DB=":memory:"` for the spawned server.

**Testing**: `node:test` through `tsx`.

- In process: `Client` and `createMcpServer` linked by `InMemoryTransport.createLinkedPair()`,
  for the call, error and validation scenarios (fast, no child process).
- Spawned: `StdioClientTransport` runs `process.execPath --import tsx src/mcp/server.ts` with
  `OPSPILOT_DB=":memory:"`, lists the tools, calls one, closes, and checks that the child's raw
  stdout holds only JSON-RPC lines. This is the test the request asks for (FR-013).
- Startup failure: spawn with `OPSPILOT_DB` pointing below a regular file in a fresh temp
  directory, so `mkdir` fails; expect exit code 1, empty stdout, reason on stderr.
- Source guard: a test reads `src/mcp/*.ts` (non-test) and fails on `console.log`,
  `console.info` or `process.stdout.write`.

**Target Platform**: Local stdio child process of an MCP client (Claude Code, IDE, desktop app)

**Project Type**: CLI-style edge over the existing store, beside the HTTP app

**Performance Goals**: None beyond the store's; a call is one prepared statement.

**Constraints**:

- stdout carries protocol messages only (FR-009).
- Exactly three tools exposed (FR-002).
- No LLM, no API key; the only setting is `OPSPILOT_DB`.

**Scale/Scope**: 1 new shared definitions module, 2 new MCP files plus tests, `createTools`
rewired to the definitions (behaviour unchanged), 1 new dependency, 1 new npm script, 1 new
`.mcp.json` for Claude Code

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | How |
| --- | --- | --- |
| I. Layered MVC | Pass | The MCP server is an edge (controller role), like `src/http/chat-controller.ts`. It calls the store (Model) through the shared definitions only; no SQL leaves `src/store/`. |
| II. Validated Boundaries | Pass | Every MCP input is validated by the shared zod schema (the SDK parses arguments with it before the handler runs). Output is the store's already-parsed domain records, serialized as JSON text. |
| III. Domain Errors at the Edge | Pass | `DomainError` subclasses are untouched. `runToolText` turns them into `{ isError: true, text: "Error: ..." }`; the MCP edge maps that to the protocol's error result, the agent edge to plain text. |
| IV. Pure Functions | Pass | Definitions are data; `runToolText` and `createMcpServer` have no I/O of their own. Opening the database, the stdio transport, signals and `process.exit` stay in `src/mcp/server.ts`. |
| V. Tested and Green | Pass | Tests for the definitions (agent and MCP see the same names, descriptions, schemas), in-process MCP calls, the spawned list-tools test, startup failure and the stdout guard. The existing `tools.test.ts` stays green. |
| Stack | Pass | The SDK is an added dependency for a new entry point; it replaces nothing in the stack, so no amendment is needed. |
| Persistence rules | Pass | Tests use `":memory:"`. The startup failure test uses a fresh OS temp directory and removes it. No test touches `data/` or the configured `OPSPILOT_DB`. |
| Security: no secrets | Pass | The script loads `.env` through Node's flag; no agent reads it. `.mcp.json` holds no secret. |

No violations, so Complexity Tracking stays empty.

**Post-design re-check (after Phase 1)**: Pass. The contract adds one module and one edge, no
layer skip, and no copied schema.

## Project Structure

### Documentation (this feature)

```text
specs/006-mcp-server/
├── plan.md              # This file
├── research.md          # Phase 0: decisions R1-R9
├── data-model.md        # Phase 1: tool definition, tool outcome, MCP tool view
├── quickstart.md        # Phase 1: how to validate
├── contracts/
│   └── mcp-server.md    # Server identity, tool list, call results, process behaviour
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── tools/
│   ├── definitions.ts          # NEW: name, description, schema (+ run for store tools) of all
│   │                           #      six tools; runToolText(action) -> { text, isError }
│   └── definitions.test.ts     # NEW: names unique, runToolText maps domain errors, rethrows others
├── agents/
│   ├── tools.ts                # createTools reads names/descriptions/schemas/run from definitions
│   └── tools.test.ts           # + agent tool name/description/schema === definition
└── mcp/
    ├── create-server.ts        # NEW: createMcpServer(store) registers the 3 MCP tools
    ├── create-server.test.ts   # NEW: in-process client: list, call, domain error, validation
    ├── server.ts               # NEW: entry point: open store, stdio, stderr logs, shutdown
    └── server.test.ts          # NEW: spawned server: list tools, clean stdout, startup failure,
                                #      source guard against stdout writes
package.json                    # + dependency @modelcontextprotocol/sdk, + script "mcp"
.mcp.json                       # NEW: registers opspilot for Claude Code (npm run --silent mcp)
```

`index.ts`, `arena.ts` and `bench.ts` keep calling `createTools(store)`; their behaviour does not
change.

**Structure Decision**: Single project, existing layout. `src/tools/` is new and neutral: it holds
what both edges share, so `src/mcp/` never imports LangChain and `src/agents/` never imports the
MCP SDK.

## Complexity Tracking

No constitution violations to justify.
