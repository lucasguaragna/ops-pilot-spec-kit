# Quickstart: Validate the OpsPilot MCP Server

Contract: [contracts/mcp-server.md](contracts/mcp-server.md). Shapes:
[data-model.md](data-model.md).

## Prerequisites

- Node.js 22.13 or newer, `npm install` done (adds `@modelcontextprotocol/sdk`)
- No API key needed

## 1. Automated checks

```bash
npm run typecheck
npm test
```

Expected: both green. The MCP tests cover:

- spawned server lists exactly `list_alerts`, `open_incident`, `resolve_incident` (SC-001)
- each listed description and input schema equals the shared definition (SC-002, SC-003)
- every stdout line of a full session is JSON-RPC (SC-004)
- open, resolve, domain errors and invalid input through an in-process client (US2)
- a store that cannot be opened: exit 1, empty stdout, reason on stderr (US3)
- no `console.log` / `process.stdout.write` in `src/mcp/` sources

All of them use `":memory:"` or a temp directory; none touches `data/`.

## 2. Manual smoke test with the MCP Inspector (optional)

```bash
OPSPILOT_DB=":memory:" npx @modelcontextprotocol/inspector npm run --silent mcp
```

Expected: the Inspector connects to `opspilot`, Tools shows three tools, and calling
`list_alerts` with no arguments returns the seeded firing alerts. The terminal shows
`opspilot: ready ...` (stderr).

## 3. Register in Claude Code (SC-005, under 2 minutes)

1. The repository ships `.mcp.json` with the `opspilot` server.
2. Start Claude Code in the repository root and approve the project server when asked.
3. Run `/mcp`: `opspilot` is connected with 3 tools.
4. Ask "what alerts are firing?": Claude calls `mcp__opspilot__list_alerts`.

## 4. Shared state with the HTTP app (SC-006, optional)

1. `npm run dev` in one terminal (uses `./data/opspilot.db` unless `OPSPILOT_DB` says otherwise).
2. From Claude Code, open an incident through `open_incident` for a service from `list_alerts`.
3. `curl` the chat endpoint asking for open incidents: the new `INC-NNN` is listed, with no
   restart.

## 5. Startup failure (US3, scenario 2)

```bash
OPSPILOT_DB=/dev/null/x.db npm run --silent mcp > out.txt; echo "exit $?"; wc -c out.txt; rm out.txt
```

Expected: a readable reason on the terminal (stderr), `exit 1`, `0 out.txt`.
