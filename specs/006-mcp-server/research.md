# Research: OpsPilot MCP Server

Phase 0 decisions for [plan.md](plan.md). The Technical Context had no `NEEDS CLARIFICATION`;
each item below settles a design choice. SDK facts were checked against the
`@modelcontextprotocol/sdk` 1.32.2 docs (the latest on npm on 2026-11-20).

## R1. Reference sketch `docs/code-examples/mcp-server.ts`

- **Decision**: Keep its shape (`McpServer`, `StdioServerTransport`, `registerTool` per tool,
  name `opspilot`). Drop its inline schema and description.
- **Rationale**: The sketch is unfinished (the handler body does not compile), and its inline
  schema contradicts the domain: field `service_id` instead of `service`, severity without
  `critical`, Portuguese description, and `new SqliteOpsStore()` with no path. Copying it would
  break FR-003 and FR-004 on day one.
- **Alternatives considered**: Fixing the inline schema to match. Rejected: it is still a copy
  that drifts.

## R2. Where the single definition lives

- **Decision**: New module `src/tools/definitions.ts` with one definition per tool: `name`,
  `description`, `schema`, and `run(store, input)` for the five store tools. All six tools move
  there, not only the three MCP ones, so `createTools` has one way of building every tool.
  `check_provider_status` keeps its own handler in `createTools` (it takes `deps` and is async).
- **Rationale**: `src/agents/` imports LangChain and `src/mcp/` imports the MCP SDK. A neutral
  module both can import keeps each edge free of the other's library. Moving the `run` functions
  too gives FR-005 (same operation, same result) by construction, not by review.
- **Alternatives considered**: (a) MCP reads the LangChain `tool()` objects (`.name`,
  `.description`, `.schema`). Works, but couples the MCP edge to LangChain and to `createTools`
  needing a store and deps just to read metadata. (b) Put definitions in `src/domain/schemas.ts`.
  Rejected: descriptions are model-facing prose and `run` needs `OpsStore`; the domain module
  should stay types and schemas only.

## R3. Result and error mapping

- **Decision**: Replace `toToolText(action): string` with `runToolText(action): ToolOutcome`
  where `ToolOutcome = { text: string; isError: boolean }`. Success: `JSON.stringify(result)`,
  `isError: false`. `DomainError`: `` `Error: ${message}` ``, `isError: true`. Anything else is
  re-thrown. The agent returns `outcome.text` (identical to today). MCP returns
  `{ content: [{ type: "text", text }], isError }`.
- **Rationale**: One function decides the text for both edges, so the readable message is the
  same (FR-008). Returning a value instead of a string lets MCP set `isError` without parsing the
  `Error:` prefix.
- **Alternatives considered**: MCP checks `text.startsWith("Error: ")`. Rejected: a stringly typed
  signal; a JSON result could in theory start that way.

## R4. Unexpected (non-domain) errors in an MCP call

- **Decision**: The MCP handler catches any error that `runToolText` re-throws, writes
  `opspilot: <tool> failed: <message>` to stderr, and returns
  `{ isError: true, content: [{ type: "text", text: "Error: internal error" }] }`.
- **Rationale**: The spec edge case requires an error result, a stderr line, and a live server.
  The SDK would also turn a throw into an error result, but its text would carry the raw message
  and nothing would reach stderr.
- **Alternatives considered**: Let the SDK handle the throw. Rejected for the reasons above.

## R5. Input validation

- **Decision**: Pass the shared `z.object` as `inputSchema`. The SDK converts it to JSON Schema
  for `tools/list` and parses `arguments` with it before calling the handler, so defaults
  (`status: "firing"`) and `.trim()` apply exactly as in the agent.
- **Rationale**: SDK 1.32 accepts a full zod v4 object (its zod compat layer handles v3 and v4).
  A failed parse never reaches the handler, so the store is never touched (FR-007). The SDK
  reports it as a tool error result naming the invalid field; the test asserts "rejected and
  store unchanged", not the exact SDK wording.
- **Alternatives considered**: Passing `.shape`. Works too, but loses object-level settings and
  is one more step away from "the same schema".

## R6. Contract equality test (SC-002)

- **Decision**: For each MCP tool, assert `description === definition.description` and that the
  listed `inputSchema.properties` and `required` deep-equal those of
  `z.toJSONSchema(definition.schema, { io: "input" })`. Agent side: assert each LangChain tool's
  `name`, `description` and `schema` are the definition's (same object reference for the schema).
- **Rationale**: Comparing against the zod source, not a hand-written expectation, is what makes
  SC-003 hold: editing one description changes both sides and the test still passes.
- **Alternatives considered**: Snapshot of the listed tools. Rejected: it would need updating on
  every description edit, which is the opposite of SC-003.

## R7. stdout discipline

- **Decision**: (a) The entry point writes only with `console.error`. (b) Before anything else it
  sets `console.log = console.info = console.debug = console.error`, so a dependency that logs
  cannot corrupt the channel. (c) A test scans `src/mcp/*.ts` (non-test) for `console.log`,
  `console.info` and `process.stdout.write`. (d) The spawned test parses every stdout line as
  JSON-RPC 2.0.
- **Rationale**: (c) and (d) catch our mistakes; (b) catches other people's. Together they cover
  FR-009 and SC-004.
- **Alternatives considered**: Lint rule. Rejected: no linter is set up in this project.

## R8. npm script and the `npm run` banner

- **Decision**: `"mcp": "node --env-file-if-exists=.env --import tsx src/mcp/server.ts"`.
  `.mcp.json` launches it with `npm run --silent mcp`.
- **Rationale**: Same pattern as `dev`, `arena` and `bench`, so `OPSPILOT_DB` set in `.env` is
  honoured without any agent reading the file (FR-011). Checked locally: npm 12 writes its
  `npm notice run ...` banner to stderr, not stdout, so plain `npm run mcp` is already safe;
  `--silent` also keeps older npm versions (which printed `> pkg@ver script` to stdout) safe.
  `tsx` loaded with `--import` prints nothing.
- **Alternatives considered**: The requested `tsx src/mcp/server.ts`. Rejected: it would not
  load `.env`; the request allows changing the script for that reason.

## R9. Shutdown

- **Decision**: One idempotent `shutdown(code)` closes the MCP server and the store, then exits.
  It runs on `process.stdin` `end`, on the transport's `onclose`, and on `SIGINT` and `SIGTERM`.
- **Rationale**: Clients usually stop a stdio server by closing its stdin; the stdio server
  transport does not end the process by itself, and an open `DatabaseSync` handle should be
  closed (FR-012). Idempotent because several of these events fire together.
- **Alternatives considered**: Rely on process exit to release the file. Works on most systems
  but leaves WAL cleanup to chance and gives no shutdown log.
