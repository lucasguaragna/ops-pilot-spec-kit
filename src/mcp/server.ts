import "./stdout-guard.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath, openOpsStore } from "../store/sqlite-ops-store.ts";
import { createMcpServer } from "./create-server.ts";

function openStoreOrExit() {
  try {
    return openOpsStore();
  } catch (error) {
    // Nothing is on stdout yet and no transport exists: the reason goes to stderr and the client sees a dead process.
    console.error(`opspilot: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const store = openStoreOrExit();
const server = createMcpServer(store, { logError: (line) => console.error(line) });

let stopping = false;
/** Idempotent: stdin end, transport close and the signals can all fire for one shutdown. */
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.error("opspilot: shutting down");
  try {
    await server.close();
  } finally {
    store.close();
    process.exit(code);
  }
}

server.server.onclose = () => void shutdown(0);
process.stdin.on("end", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await server.connect(new StdioServerTransport());
console.error(`opspilot: ready (db: ${resolveDbPath(process.env)})`);
