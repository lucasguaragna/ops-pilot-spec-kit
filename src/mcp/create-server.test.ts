import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SqliteOpsStore } from "../store/sqlite-ops-store.ts";
import { TOOL_DEFINITIONS, runToolText } from "../tools/definitions.ts";
import { MCP_TOOL_NAMES, createMcpServer } from "./create-server.ts";

const packageVersion: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A client linked in process to a fresh server on a `":memory:"` store. */
async function connect(store = new SqliteOpsStore(":memory:"), logError?: (line: string) => void) {
  cleanups.push(() => store.close());
  const server = createMcpServer(store, logError ? { logError } : {});
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { store, client };
}

describe("createMcpServer: discovery", () => {
  it("identifies itself as opspilot with the package version", async () => {
    const { client } = await connect();
    const info = client.getServerVersion();
    assert.equal(info?.name, "opspilot");
    assert.equal(info?.version, packageVersion);
  });

  it("lists exactly the three tools, in order", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((item) => item.name),
      ["list_alerts", "open_incident", "resolve_incident"],
    );
    assert.deepEqual([...MCP_TOOL_NAMES], tools.map((item) => item.name));
  });

  it("lists the description and input schema of the shared definitions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const listed of tools) {
      const definition = TOOL_DEFINITIONS.find((item) => item.name === listed.name);
      assert.ok(definition, listed.name);
      assert.equal(listed.description, definition.description);
      const expected = z.toJSONSchema(definition.schema, { io: "input" }) as {
        properties?: unknown;
        required?: string[];
      };
      assert.deepEqual(listed.inputSchema.properties, expected.properties, `${listed.name} properties`);
      assert.deepEqual(listed.inputSchema.required ?? [], expected.required ?? [], `${listed.name} required`);
    }
  });
});

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

/** Calls a tool; a protocol error counts as rejected too. Returns null when the call was rejected by the protocol. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult | null> {
  try {
    return (await client.callTool({ name, arguments: args })) as CallResult;
  } catch {
    return null;
  }
}

const textOf = (result: CallResult | null) => result?.content[0]?.text;

describe("createMcpServer: calls", () => {
  it("list_alerts defaults to firing and returns the agent's text", async () => {
    const { store, client } = await connect();
    const result = await call(client, "list_alerts", {});
    assert.equal(result?.content.length, 1);
    assert.equal(textOf(result), runToolText(() => store.listAlerts("firing")).text);
    assert.ok(!result?.isError);
  });

  it("open_incident then resolve_incident change the store", async () => {
    const { store, client } = await connect();
    const service = store.listAlerts("firing")[0]!.service;
    const opened = await call(client, "open_incident", { title: "Checkout slow", service, severity: "high" });
    assert.ok(!opened?.isError);
    const incident = JSON.parse(textOf(opened)!);
    assert.match(incident.id, /^INC-\d{3}$/);
    assert.ok(store.listIncidents("open").some((item) => item.id === incident.id));

    const resolved = await call(client, "resolve_incident", { id: incident.id, summary: "rolled back" });
    assert.ok(!resolved?.isError);
    const closed = JSON.parse(textOf(resolved)!);
    assert.equal(closed.summary, "rolled back");
    assert.notEqual(closed.resolvedAt, null);
  });

  it("returns domain errors as error results with the agent's text", async () => {
    const { store, client } = await connect();
    const service = store.listAlerts("firing")[0]!.service;

    const unknownService = await call(client, "open_incident", { title: "x", service: "nope", severity: "low" });
    assert.equal(unknownService?.isError, true);
    assert.match(textOf(unknownService)!, /^Error: Service not found: nope/);

    const unknownIncident = await call(client, "resolve_incident", { id: "INC-999" });
    assert.equal(unknownIncident?.isError, true);
    assert.match(textOf(unknownIncident)!, /^Error: Incident not found/);

    const created = JSON.parse(textOf(await call(client, "open_incident", { title: "x", service, severity: "low" }))!);
    await call(client, "resolve_incident", { id: created.id });
    const again = await call(client, "resolve_incident", { id: created.id });
    assert.equal(again?.isError, true);
    assert.match(textOf(again)!, /^Error: Incident already resolved/);
  });

  it("rejects invalid input and leaves the store unchanged", async () => {
    const { store, client } = await connect();
    const before = store.getState();
    const badSeverity = await call(client, "open_incident", { title: "x", service: "checkout-api", severity: "urgent" });
    const noTitle = await call(client, "open_incident", { service: "checkout-api", severity: "low" });
    for (const result of [badSeverity, noTitle]) assert.ok(result === null || result.isError === true);
    assert.deepEqual(store.getState(), before);
  });

  it("does not expose get_runbook", async () => {
    const { client } = await connect();
    const result = await call(client, "get_runbook", { service: "checkout-api" });
    assert.ok(result === null || (result.isError === true && /get_runbook/.test(textOf(result) ?? "")));
  });

  it("turns an unexpected failure into 'Error: internal error', logs it and keeps serving", async () => {
    const store = new SqliteOpsStore(":memory:");
    store.listAlerts = () => {
      throw new Error("boom");
    };
    const logged: string[] = [];
    const { client } = await connect(store, (line) => logged.push(line));

    const result = await call(client, "list_alerts", {});
    assert.deepEqual(result, { isError: true, content: [{ type: "text", text: "Error: internal error" }] });
    assert.deepEqual(logged, ["opspilot: list_alerts failed: boom"]);
    assert.equal((await client.listTools()).tools.length, 3);
  });
});
