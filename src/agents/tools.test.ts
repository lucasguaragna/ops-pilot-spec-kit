import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInitialState, createStore } from "../store/in-memory-store.ts";
import { createTools } from "./tools.ts";

function setup() {
  const store = createStore();
  const [listAlerts, openIncident, resolveIncident] = createTools(store);
  return { store, listAlerts, openIncident, resolveIncident };
}

describe("tools", () => {
  it("are named as in the contract", () => {
    const { listAlerts, openIncident, resolveIncident } = setup();
    assert.deepEqual(
      [listAlerts.name, openIncident.name, resolveIncident.name],
      ["list_alerts", "open_incident", "resolve_incident"],
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
    const incident = JSON.parse(
      await openIncident.invoke({ title: "Payments down", service: "payments-worker", severity: "critical" }),
    );
    assert.equal(incident.id, "INC-001");
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
});
