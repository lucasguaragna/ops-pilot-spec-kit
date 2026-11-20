# Contract: `opspilot` MCP Server

Interface seen by an MCP client over stdio. Field-level input contracts are not repeated here:
they are whatever `src/domain/schemas.ts` defines, converted to JSON Schema by the SDK (FR-003).

## Launch

| Item | Value |
| --- | --- |
| Command | `npm run --silent mcp` (from the repository root) |
| Script | `node --env-file-if-exists=.env --import tsx src/mcp/server.ts` |
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Setting | `OPSPILOT_DB` (optional; blank or unset means `./data/opspilot.db`) |
| Secrets | None. No model or API key is used. |

## `initialize`

The server answers with `serverInfo.name = "opspilot"` and a `tools` capability.

## `tools/list`

Returns exactly three tools, in this order. Each `description` and `inputSchema` comes from the
shared definition of the same name.

| Name | Input (from schema) | Required |
| --- | --- | --- |
| `list_alerts` | `status`: `firing` \| `resolved` \| `all`, default `firing` | none |
| `open_incident` | `title`, `service`, `severity`: `low` \| `medium` \| `high` \| `critical` | all three |
| `resolve_incident` | `id` (INC-NNN), `summary` (optional) | `id` |

Not exposed: `list_incidents`, `get_runbook`, `check_provider_status`.

## `tools/call`

| Situation | Result |
| --- | --- |
| Success | `{ content: [{ type: "text", text: <JSON of the store result> }] }`, the same text the agent tool returns |
| Domain error (unknown service, unknown incident, already resolved) | `{ isError: true, content: [{ type: "text", text: "Error: <message>" }] }`, the same text the agent tool returns |
| Arguments break the schema | Rejected by the SDK before the handler; store unchanged |
| Unexpected failure | `{ isError: true, content: [{ type: "text", text: "Error: internal error" }] }`; details on stderr |
| Unknown tool name | Protocol error from the SDK (tool not found) |

The server keeps running in every case.

## Streams and exit

| Stream or event | Behaviour |
| --- | --- |
| stdout | JSON-RPC messages only. Never anything else. |
| stderr | `opspilot: ready (db: <path>)`, `opspilot: shutting down`, failures. Never secret values. |
| stdin closed, transport closed, `SIGINT`, `SIGTERM` | Close server and store, exit 0 |
| Store cannot be opened | `StoreOpenError` message on stderr, nothing on stdout, exit 1 |

## Claude Code registration (`.mcp.json`)

```json
{
  "mcpServers": {
    "opspilot": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"]
    }
  }
}
```
