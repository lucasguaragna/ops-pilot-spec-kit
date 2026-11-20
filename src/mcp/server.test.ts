import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("opspilot MCP server (spawned)", () => {
  it("starts over stdio and lists exactly the three tools", { timeout: 20_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd: repoRoot,
      env: { ...(process.env as Record<string, string>), OPSPILOT_DB: ":memory:" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, "opspilot");
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((item) => item.name),
        ["list_alerts", "open_incident", "resolve_incident"],
      );
    } finally {
      await client.close();
    }
  });
});

/** Spawns the real entry point with the given database setting and collects both streams. */
function spawnServer(db: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OPSPILOT_DB: db },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = once(child, "close").then(([code]) => code as number | null);
  return { child, exited, out: () => stdout, err: () => stderr };
}

const rpc = (message: object) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";

describe("opspilot MCP server: protocol channel", () => {
  it("writes only JSON-RPC to stdout and exits 0 when stdin ends", { timeout: 20_000 }, async () => {
    const server = spawnServer(":memory:");
    server.child.stdin.write(
      rpc({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
      }),
    );
    server.child.stdin.write(rpc({ method: "notifications/initialized" }));
    server.child.stdin.write(rpc({ id: 2, method: "tools/list" }));
    server.child.stdin.write(rpc({ id: 3, method: "tools/call", params: { name: "list_alerts", arguments: {} } }));

    // Wait for the last response (id 3), then close stdin.
    const deadline = Date.now() + 15_000;
    while (!server.out().includes('"id":3') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    server.child.stdin.end();
    const code = await server.exited;

    assert.equal(code, 0);
    const lines = server.out().split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length >= 3, `expected 3 responses, got ${lines.length}`);
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", line);
    assert.match(server.err(), /opspilot: ready/);
    assert.match(server.err(), /opspilot: shutting down/);
  });

  it("exits 1 with an empty stdout when the database cannot be opened", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "opspilot-mcp-"));
    try {
      await writeFile(join(dir, "blocker"), "a regular file, not a directory");
      const server = spawnServer(join(dir, "blocker", "x.db"));
      const code = await server.exited;
      assert.equal(code, 1);
      assert.equal(server.out(), "");
      assert.match(server.err(), /^opspilot: Cannot open database/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("src/mcp sources", () => {
  it("never write to stdout", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    assert.ok(files.length >= 3);
    for (const name of files) {
      const source = await readFile(join(dir, name), "utf8");
      assert.doesNotMatch(source, /console\.(log|info|debug)\(/, `${name} calls console.log/info/debug`);
      assert.doesNotMatch(source, /process\.stdout\.write/, `${name} writes to process.stdout`);
    }
  });
});
