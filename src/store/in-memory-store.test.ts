import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IncidentAlreadyResolvedError,
  IncidentNotFoundError,
  ServiceNotFoundError,
} from "../domain/errors.ts";
import {
  createInitialState,
  createStore,
  listAlerts,
  openIncident,
  resolveIncident,
} from "./in-memory-store.ts";

const incidentInput = { title: "Checkout latency", service: "checkout-api", severity: "high" } as const;

describe("seed", () => {
  it("has 6 unique services, 4 firing and 3 resolved alerts, and no incidents", () => {
    const state = createInitialState();
    assert.equal(new Set(state.services.map((service) => service.name)).size, 6);
    assert.equal(listAlerts(state, "firing").length, 4);
    assert.equal(listAlerts(state, "resolved").length, 3);
    assert.equal(state.incidents.length, 0);
  });

  it("only references known services", () => {
    const state = createInitialState();
    const names = new Set(state.services.map((service) => service.name));
    assert.ok(state.alerts.every((alert) => names.has(alert.service)));
  });
});

describe("listAlerts", () => {
  it("filters by status, and 'all' returns every alert", () => {
    const state = createInitialState();
    assert.ok(listAlerts(state, "firing").every((alert) => alert.status === "firing"));
    assert.equal(listAlerts(state, "all").length, 7);
  });
});

describe("openIncident", () => {
  it("creates open incidents with sequential identifiers", () => {
    const first = openIncident(createInitialState(), incidentInput);
    const second = openIncident(first.state, incidentInput);
    assert.equal(first.incident.id, "INC-001");
    assert.equal(first.incident.status, "open");
    assert.equal(second.incident.id, "INC-002");
    assert.equal(second.state.incidents.length, 2);
  });

  it("leaves the previous state unchanged", () => {
    const state = createInitialState();
    openIncident(state, incidentInput);
    assert.deepEqual(state, createInitialState());
  });

  it("rejects an unknown service", () => {
    assert.throws(
      () => openIncident(createInitialState(), { ...incidentInput, service: "unknown" }),
      ServiceNotFoundError,
    );
  });
});

describe("resolveIncident", () => {
  it("resolves an open incident and leaves the previous state unchanged", () => {
    const opened = openIncident(createInitialState(), incidentInput);
    const resolved = resolveIncident(opened.state, "INC-001");
    assert.equal(resolved.incident.status, "resolved");
    assert.equal(opened.state.incidents[0]?.status, "open");
  });

  it("rejects an unknown incident", () => {
    assert.throws(() => resolveIncident(createInitialState(), "INC-404"), IncidentNotFoundError);
  });

  it("rejects an incident that is already resolved", () => {
    const opened = openIncident(createInitialState(), incidentInput);
    const resolved = resolveIncident(opened.state, "INC-001");
    assert.throws(() => resolveIncident(resolved.state, "INC-001"), IncidentAlreadyResolvedError);
  });
});

describe("createStore", () => {
  it("keeps state between calls and reset restores the seed", () => {
    const store = createStore();
    store.openIncident(incidentInput);
    assert.equal(store.getState().incidents.length, 1);
    store.reset();
    assert.deepEqual(store.getState(), createInitialState());
    assert.equal(store.openIncident(incidentInput).id, "INC-001");
  });
});
