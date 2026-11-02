import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { StoreFileError } from "../domain/errors.ts";
import { createInitialState, createStore } from "./in-memory-store.ts";
import { createJsonFileBackend, parseStoreState, serializeStoreState } from "./json-file-store.ts";

const directory = mkdtempSync(join(tmpdir(), "ops-pilot-store-"));
after(() => rmSync(directory, { recursive: true, force: true }));

describe("JSON file store", () => {
  it("creates the file from the seed when it is missing", () => {
    const path = join(directory, "missing", "db.json");
    const store = createStore(createJsonFileBackend(path));

    assert.equal(store.listAlerts("firing").length, 4);
    assert.equal(existsSync(path), true);
    assert.deepEqual(parseStoreState(path, readFileSync(path, "utf8")), createInitialState());
  });

  it("keeps new incidents across store instances", () => {
    const path = join(directory, "persist.json");
    const first = createStore(createJsonFileBackend(path));
    first.openIncident({ title: "Checkout errors", service: "checkout-api", severity: "high" });

    const second = createStore(createJsonFileBackend(path));
    const incident = second.resolveIncident("INC-001");

    assert.equal(incident.status, "resolved");
    assert.equal(second.getState().nextIncidentNumber, 2);
  });

  it("reset writes the seed back", () => {
    const path = join(directory, "reset.json");
    const store = createStore(createJsonFileBackend(path));
    store.openIncident({ title: "Search slow", service: "search-api", severity: "medium" });
    store.reset();

    assert.deepEqual(store.getState(), createInitialState());
  });

  it("rejects a file that is not valid JSON or does not match the store shape", () => {
    const path = join(directory, "broken.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => createStore(createJsonFileBackend(path)).getState(), StoreFileError);

    writeFileSync(path, JSON.stringify({ services: [] }));
    assert.throws(() => createStore(createJsonFileBackend(path)).getState(), StoreFileError);
  });

  it("serializes and parses the same state", () => {
    const state = createInitialState();
    assert.deepEqual(parseStoreState("memory", serializeStoreState(state)), state);
  });
});
