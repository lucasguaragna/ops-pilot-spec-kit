import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DomainError, ServiceNotFoundError } from "../domain/errors.ts";
import {
  CheckProviderStatusInput,
  GetRunbookInput,
  ListAlertsInput,
  ListIncidentsInput,
  OpenIncidentInput,
  ResolveIncidentInput,
} from "../domain/schemas.ts";
import { SqliteOpsStore } from "../store/sqlite-ops-store.ts";
import {
  TOOL_DEFINITIONS,
  getRunbookDefinition,
  listAlertsDefinition,
  listIncidentsDefinition,
  openIncidentDefinition,
  resolveIncidentDefinition,
  runToolText,
} from "./definitions.ts";

const opened: SqliteOpsStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function newStore() {
  const store = new SqliteOpsStore(":memory:");
  opened.push(store);
  return store;
}

describe("tool definitions", () => {
  it("has the six tools, with unique names", () => {
    const names = TOOL_DEFINITIONS.map((definition) => definition.name);
    assert.deepEqual(names, [
      "list_alerts",
      "open_incident",
      "resolve_incident",
      "list_incidents",
      "get_runbook",
      "check_provider_status",
    ]);
    assert.equal(new Set(names).size, names.length);
  });

  it("references the domain schemas instead of copying them", () => {
    const expected = {
      list_alerts: ListAlertsInput,
      open_incident: OpenIncidentInput,
      resolve_incident: ResolveIncidentInput,
      list_incidents: ListIncidentsInput,
      get_runbook: GetRunbookInput,
      check_provider_status: CheckProviderStatusInput,
    };
    for (const definition of TOOL_DEFINITIONS) {
      assert.strictEqual(definition.schema, expected[definition.name], definition.name);
    }
  });

  it("describes every tool", () => {
    for (const definition of TOOL_DEFINITIONS) {
      assert.equal(typeof definition.description, "string");
      assert.ok(definition.description.length > 0, definition.name);
    }
  });

  it("gives run to the five store tools and not to check_provider_status", () => {
    for (const definition of TOOL_DEFINITIONS) {
      const hasRun = "run" in definition && typeof definition.run === "function";
      assert.equal(hasRun, definition.name !== "check_provider_status", definition.name);
    }
  });

  it("run calls the matching store method", () => {
    const store = newStore();

    assert.deepEqual(listAlertsDefinition.run(store, { status: "firing" }), store.listAlerts("firing"));
    assert.deepEqual(listIncidentsDefinition.run(store, { status: "all" }), store.listIncidents("all"));
    assert.deepEqual(getRunbookDefinition.run(store, { service: "checkout-api" }), store.getRunbook("checkout-api"));

    const created = openIncidentDefinition.run(store, { title: "Slow checkout", service: "checkout-api", severity: "high" });
    assert.equal(store.listIncidents("open")[0]?.id, created.id);

    const resolved = resolveIncidentDefinition.run(store, { id: created.id, summary: "rolled back" });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.summary, "rolled back");
  });
});

describe("runToolText", () => {
  it("returns the JSON of the value", () => {
    const value = { id: "INC-001", tags: ["a"] };
    assert.deepEqual(
      runToolText(() => value),
      { text: JSON.stringify(value), isError: false },
    );
  });

  it("turns a DomainError into Error: <message>", () => {
    const outcome = runToolText(() => {
      throw new ServiceNotFoundError("nope", ["checkout-api"]);
    });
    assert.equal(outcome.isError, true);
    assert.ok(outcome.text.startsWith("Error: "));
    assert.ok(outcome.text.includes("nope"));
  });

  it("uses the message of any DomainError subclass", () => {
    class Custom extends DomainError {}
    assert.deepEqual(
      runToolText(() => {
        throw new Custom("custom failure");
      }),
      { text: "Error: custom failure", isError: true },
    );
  });

  it("re-throws anything that is not a DomainError", () => {
    assert.throws(
      () =>
        runToolText(() => {
          throw new Error("boom");
        }),
      /boom/,
    );
  });
});
