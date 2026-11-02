import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { createInitialState } from "../store/in-memory-store.ts";
import { SqliteOpsStore } from "../store/sqlite-ops-store.ts";
import { createTools } from "./tools.ts";

const opened: SqliteOpsStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function setup() {
  const store = new SqliteOpsStore(":memory:");
  opened.push(store);
  const [listAlerts, openIncident, resolveIncident, listIncidents, getRunbook] = createTools(store);
  return { store, listAlerts, openIncident, resolveIncident, listIncidents, getRunbook };
}

const incident = (service: string) => ({ title: `Problem in ${service}`, service, severity: "high" }) as const;

describe("tools", () => {
  it("are named as in the contract", () => {
    const tools = createTools(new SqliteOpsStore(":memory:"));
    assert.deepEqual(
      tools.map((item) => item.name),
      ["list_alerts", "open_incident", "resolve_incident", "list_incidents", "get_runbook"],
    );
  });

  it("list_alerts returns JSON text and defaults to firing", async () => {
    const { listAlerts } = setup();
    const alerts = JSON.parse(await listAlerts.invoke({}));
    assert.equal(alerts.length, 4);
    assert.ok(alerts.every((alert: { status: string }) => alert.status === "firing"));
  });

  it("open_incident and resolve_incident change the store", async () => {
    const { store, openIncident, resolveIncident } = setup();
    const created = JSON.parse(
      await openIncident.invoke({ title: "Payments down", service: "payments-worker", severity: "critical" }),
    );
    assert.equal(created.id, "INC-001");
    const resolved = JSON.parse(await resolveIncident.invoke({ id: "INC-001" }));
    assert.equal(resolved.status, "resolved");
    assert.equal(store.getState().incidents[0]?.status, "resolved");
  });

  it("rejects invalid input and leaves data unchanged", async () => {
    const { store, openIncident } = setup();
    await assert.rejects(
      openIncident.invoke({ title: "x", service: "checkout-api", severity: "urgent" } as never),
    );
    assert.deepEqual(store.getState(), createInitialState());
  });

  it("returns domain errors as text starting with 'Error:'", async () => {
    const { openIncident, resolveIncident } = setup();
    const unknownService = await openIncident.invoke({ title: "x", service: "nope", severity: "low" });
    assert.match(unknownService, /^Error: Service not found: nope/);
    assert.match(unknownService, /Known services: checkout-api, payments-worker, auth-service/);
    assert.match(await resolveIncident.invoke({ id: "INC-999" }), /^Error: Incident not found/);
  });

  it("returns 'already resolved' as text", async () => {
    const { openIncident, resolveIncident } = setup();
    await openIncident.invoke(incident("checkout-api"));
    await resolveIncident.invoke({ id: "INC-001" });
    assert.match(await resolveIncident.invoke({ id: "INC-001" }), /^Error: Incident already resolved/);
  });
});

describe("list_incidents", () => {
  async function withThreeIncidents() {
    const ctx = setup();
    for (const service of ["checkout-api", "payments-worker", "auth-service"]) {
      await ctx.openIncident.invoke(incident(service));
    }
    await ctx.resolveIncident.invoke({ id: "INC-002" });
    return ctx;
  }
  const ids = (text: string) => JSON.parse(text).map((item: { id: string }) => item.id);

  it("defaults to the open incidents", async () => {
    const { listIncidents } = await withThreeIncidents();
    assert.deepEqual(ids(await listIncidents.invoke({})), ["INC-001", "INC-003"]);
  });

  it("filters by resolved and all, ordered by id", async () => {
    const { listIncidents } = await withThreeIncidents();
    assert.deepEqual(ids(await listIncidents.invoke({ status: "resolved" })), ["INC-002"]);
    assert.deepEqual(ids(await listIncidents.invoke({ status: "all" })), ["INC-001", "INC-002", "INC-003"]);
  });

  it("rejects a status outside the set before the store is called", async () => {
    const { store, listIncidents } = await withThreeIncidents();
    const before = store.getState();
    await assert.rejects(listIncidents.invoke({ status: "closed" } as never));
    assert.deepEqual(store.getState(), before);
  });

  it("resolve_incident keeps the summary and sets resolvedAt", async () => {
    const { openIncident, resolveIncident } = setup();
    await openIncident.invoke(incident("checkout-api"));
    const resolved = JSON.parse(await resolveIncident.invoke({ id: "INC-001", summary: "Rolled back deploy" }));
    assert.equal(resolved.summary, "Rolled back deploy");
    assert.notEqual(resolved.resolvedAt, null);
  });
});

describe("get_runbook", () => {
  it("returns the title and steps for each service that has one", async () => {
    const { getRunbook } = setup();
    for (const service of ["checkout-api", "payments-worker", "auth-service"]) {
      const runbook = JSON.parse(await getRunbook.invoke({ service }));
      assert.equal(runbook.service, service);
      assert.ok(runbook.title.length > 0);
      assert.ok(runbook.steps.length > 0);
    }
  });

  it("names the services that have a runbook when the service has none", async () => {
    const { getRunbook } = setup();
    const text = await getRunbook.invoke({ service: "search-api" });
    assert.match(text, /^Error:/);
    for (const name of ["checkout-api", "payments-worker", "auth-service"]) assert.ok(text.includes(name));
  });

  it("lists the known services when the service does not exist", async () => {
    const { getRunbook } = setup();
    const text = await getRunbook.invoke({ service: "nope" });
    assert.match(text, /^Error: Service not found: nope/);
    assert.match(text, /Known services: checkout-api/);
  });
});

describe("tool definitions", () => {
  const tools = createTools(new SqliteOpsStore(":memory:"));
  const byName = Object.fromEntries(tools.map((item) => [item.name, item]));

  /** The description can sit on the wrapper or on the inner type. */
  function describeField(field: z.ZodType): string | undefined {
    if (field.description) return field.description;
    if (field instanceof z.ZodDefault || field instanceof z.ZodOptional) return describeField(field.unwrap() as z.ZodType);
    return undefined;
  }

  function base(field: z.ZodType): z.ZodType {
    return field instanceof z.ZodDefault || field instanceof z.ZodOptional ? base(field.unwrap() as z.ZodType) : field;
  }

  it("describes every argument", () => {
    for (const item of tools) {
      const shape = (item.schema as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const [key, field] of Object.entries(shape)) {
        assert.ok(describeField(field), `${item.name}.${key} has no description`);
      }
    }
  });

  it("uses enums for every status and severity", () => {
    for (const item of tools) {
      const shape = (item.schema as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const key of ["status", "severity"]) {
        const field = shape[key];
        if (field) assert.ok(base(field) instanceof z.ZodEnum, `${item.name}.${key} is not an enum`);
      }
    }
  });

  it("tells the model when to use open_incident and to check list_incidents first", () => {
    assert.ok(byName.open_incident?.description.includes("list_incidents"));
  });

  it("says how to identify records", () => {
    assert.ok(byName.resolve_incident?.description.includes("INC-NNN"));
    assert.ok(byName.list_incidents?.description.includes("INC-NNN"));
    assert.ok(byName.open_incident?.description.includes("list_alerts"));
    assert.ok(byName.get_runbook?.description.includes("list_alerts"));
  });
});
