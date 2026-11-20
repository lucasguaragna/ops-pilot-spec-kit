import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpsStore } from "../store/ops-store.ts";
import {
  listAlertsDefinition,
  openIncidentDefinition,
  resolveIncidentDefinition,
  runToolText,
} from "../tools/definitions.ts";

/** The tools exposed over MCP, in listing order. The agent's other tools stay agent-only. */
export const MCP_TOOL_NAMES = ["list_alerts", "open_incident", "resolve_incident"] as const;

const packageVersion: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export interface McpServerOptions {
  /** Where diagnostics go. The entry point sends them to stderr: stdout belongs to the protocol. */
  logError?: (line: string) => void;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

/**
 * Same text as the agent's tool. A non-domain error never reaches the client raw: the client gets a
 * fixed message, the details go to `logError` (stderr), and the server keeps running.
 */
function toResult(name: string, action: () => unknown, logError: (line: string) => void): ToolResult {
  try {
    const { text, isError } = runToolText(action);
    return { content: [{ type: "text", text }], isError };
  } catch (error) {
    logError(`opspilot: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return { content: [{ type: "text", text: "Error: internal error" }], isError: true };
  }
}

/** Builds the `opspilot` MCP server on top of the shared tool definitions. It does not connect a transport. */
export function createMcpServer(store: OpsStore, options: McpServerOptions = {}): McpServer {
  const logError = options.logError ?? ((line: string) => console.error(line));
  const server = new McpServer({ name: "opspilot", version: packageVersion });

  server.registerTool(
    listAlertsDefinition.name,
    { description: listAlertsDefinition.description, inputSchema: listAlertsDefinition.schema },
    (input) => toResult(listAlertsDefinition.name, () => listAlertsDefinition.run(store, input), logError),
  );

  server.registerTool(
    openIncidentDefinition.name,
    { description: openIncidentDefinition.description, inputSchema: openIncidentDefinition.schema },
    (input) => toResult(openIncidentDefinition.name, () => openIncidentDefinition.run(store, input), logError),
  );

  server.registerTool(
    resolveIncidentDefinition.name,
    { description: resolveIncidentDefinition.description, inputSchema: resolveIncidentDefinition.schema },
    (input) => toResult(resolveIncidentDefinition.name, () => resolveIncidentDefinition.run(store, input), logError),
  );

  return server;
}
