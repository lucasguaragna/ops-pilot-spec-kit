import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IncidentAlreadyResolvedError,
  IncidentNotFoundError,
  RunbookNotFoundError,
  ServiceNotFoundError,
} from "../domain/errors.ts";
import type { OpenIncidentInput } from "../domain/schemas.ts";
import { createInitialState } from "./in-memory-store.ts";
import type { OpsStore } from "./ops-store.ts";

const NOW = "2026-11-02T12:00:00.000Z";
const input: OpenIncidentInput = { title: "Checkout latency", service: "checkout-api", severity: "high" };

/**
 * Behaviour every OpsStore must share. Not a *.test.ts file, so the runner only loads it
 * through the store test files that import it.
 */
export function runOpsStoreContract(label: string, makeStore: (now: () => string) => OpsStore): void {
  describe(`OpsStore contract: ${label}`, () => {
    const fresh = () => makeStore(() => NOW);

    it("starts at the seed state", () => {
      assert.deepEqual(fresh().getState(), createInitialState());
    });

    it("lists the firing alerts in id order", () => {
      assert.deepEqual(
        fresh()
          .listAlerts("firing")
          .map((alert) => alert.id),
        ["ALT-001", "ALT-002", "ALT-003", "ALT-007"],
      );
    });

    it("opens incidents with sequential ids, open and with no resolution", () => {
      const store = fresh();
      const first = store.openIncident(input);
      const second = store.openIncident(input);
      assert.deepEqual([first.id, second.id], ["INC-001", "INC-002"]);
      for (const incident of [first, second]) {
        assert.equal(incident.status, "open");
        assert.equal(incident.resolvedAt, null);
        assert.equal(incident.summary, null);
      }
    });

    it("resolves an incident and keeps the summary", () => {
      const store = fresh();
      store.openIncident(input);
      const resolved = store.resolveIncident({ id: "INC-001", summary: "Rolled back deploy" });
      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.resolvedAt, NOW);
      assert.equal(resolved.summary, "Rolled back deploy");
    });

    it("resolves an incident without a summary", () => {
      const store = fresh();
      store.openIncident(input);
      const resolved = store.resolveIncident({ id: "INC-001" });
      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.summary, null);
    });

    it("filters incidents by status", () => {
      const store = fresh();
      store.openIncident(input);
      store.openIncident(input);
      store.openIncident(input);
      store.resolveIncident({ id: "INC-002" });
      assert.deepEqual(
        store.listIncidents("open").map((incident) => incident.id),
        ["INC-001", "INC-003"],
      );
      assert.deepEqual(
        store.listIncidents("resolved").map((incident) => incident.id),
        ["INC-002"],
      );
      assert.equal(store.listIncidents("all").length, 3);
    });

    it("returns the title and ordered steps of a runbook", () => {
      const runbook = fresh().getRunbook("checkout-api");
      assert.equal(runbook.service, "checkout-api");
      assert.ok(runbook.title.length > 0);
      assert.ok(runbook.steps.length >= 3);
    });

    it("says which services have a runbook when a known service has none", () => {
      assert.throws(
        () => fresh().getRunbook("search-api"),
        (error: unknown) =>
          error instanceof RunbookNotFoundError &&
          error.message.includes("checkout-api, payments-worker, auth-service"),
      );
    });

    it("lists the known services when the service for a runbook does not exist", () => {
      assert.throws(
        () => fresh().getRunbook("nope"),
        (error: unknown) =>
          error instanceof ServiceNotFoundError && error.message.includes("Known services: checkout-api"),
      );
    });

    it("stores free text verbatim and never runs it", () => {
      const store = fresh();
      const title = "x'); DROP TABLE alerts;--";
      const incident = store.openIncident({ ...input, title });
      assert.equal(incident.title, title);
      assert.equal(store.listIncidents("all")[0]?.title, title);
      assert.equal(store.listAlerts("all").length, 7);
    });

    it("rejects an unknown service and stores no incident", () => {
      const store = fresh();
      assert.throws(() => store.openIncident({ ...input, service: "nope" }), ServiceNotFoundError);
      assert.equal(store.listIncidents("all").length, 0);
    });

    it("rejects an unknown incident id", () => {
      assert.throws(() => fresh().resolveIncident({ id: "INC-999" }), IncidentNotFoundError);
    });

    it("rejects resolving twice and keeps the first resolution time", () => {
      let current = NOW;
      const store = makeStore(() => current);
      store.openIncident(input);
      store.resolveIncident({ id: "INC-001" });
      current = "2026-11-02T13:00:00.000Z";
      assert.throws(() => store.resolveIncident({ id: "INC-001" }), IncidentAlreadyResolvedError);
      assert.equal(store.listIncidents("all")[0]?.resolvedAt, NOW);
    });

    it("goes back to the seed on reset", () => {
      const store = fresh();
      store.openIncident(input);
      store.reset();
      assert.deepEqual(store.getState(), createInitialState());
      assert.equal(store.openIncident(input).id, "INC-001");
    });
  });
}
