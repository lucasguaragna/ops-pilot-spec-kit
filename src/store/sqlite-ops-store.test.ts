import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { StoreOpenError } from "../domain/errors.ts";
import { AlertStatus, IncidentStatus, Severity } from "../domain/schemas.ts";
import { runOpsStoreContract } from "./ops-store-contract.ts";
import { openOpsStore, resolveDbPath, SCHEMA, SqliteOpsStore } from "./sqlite-ops-store.ts";

const CHECK_FAILED = /CHECK constraint failed/;
const FIRED_AT = "2026-11-02T08:40:00Z";

runOpsStoreContract("sqlite", (now) => new SqliteOpsStore(":memory:", { now }));

/** A raw database with the schema and one parent service, to insert rows the store would never write. */
function rawDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO services (name, tier) VALUES (?, ?)").run("svc", 1);
  return db;
}

const insertAlert = (db: DatabaseSync, severity: string, status: string) =>
  db
    .prepare("INSERT INTO alerts (id, title, service, severity, status, fired_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`ALT-${Math.random()}`, "t", "svc", severity, status, FIRED_AT);

const insertIncident = (db: DatabaseSync, severity: string, status: string, resolvedAt: string | null) =>
  db
    .prepare(
      "INSERT INTO incidents (id, title, service, severity, status, resolved_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(`INC-${Math.random()}`, "t", "svc", severity, status, resolvedAt, null);

describe("SQLite CHECK constraints", () => {
  it("rejects values outside every closed set", () => {
    const db = rawDatabase();
    assert.throws(() => insertAlert(db, "urgent", "firing"), CHECK_FAILED);
    assert.throws(() => insertAlert(db, "low", "closed"), CHECK_FAILED);
    assert.throws(() => insertIncident(db, "urgent", "open", null), CHECK_FAILED);
    assert.throws(() => insertIncident(db, "low", "closed", null), CHECK_FAILED);
    assert.throws(() => db.prepare("INSERT INTO services (name, tier) VALUES (?, ?)").run("other", 4), CHECK_FAILED);
    assert.throws(() => insertIncident(db, "low", "open", "2026-11-02T12:00:00.000Z"), CHECK_FAILED);
  });

  it("accepts every value of the zod enums, so CHECK and zod stay in step", () => {
    const db = rawDatabase();
    for (const severity of Severity.options) {
      for (const status of AlertStatus.options) insertAlert(db, severity, status);
    }
    for (const severity of Severity.options) insertIncident(db, severity, "open", null);
    assert.ok(IncidentStatus.options.includes("resolved"));
    insertIncident(db, "low", "resolved", "2026-11-02T12:00:00.000Z");
    for (const tier of [1, 2, 3]) {
      db.prepare("INSERT INTO services (name, tier) VALUES (?, ?)").run(`tier-${tier}`, tier);
    }
  });
});

describe("resolveDbPath", () => {
  it("defaults to ./data/opspilot.db when the setting is unset, empty or blank", () => {
    assert.equal(resolveDbPath({}), "./data/opspilot.db");
    assert.equal(resolveDbPath({ OPSPILOT_DB: "" }), "./data/opspilot.db");
    assert.equal(resolveDbPath({ OPSPILOT_DB: "  " }), "./data/opspilot.db");
  });

  it("trims the configured path", () => {
    assert.equal(resolveDbPath({ OPSPILOT_DB: " ./x.db " }), "./x.db");
  });
});

describe("SQLite store on a file", () => {
  // Constitution 1.3.0: a fresh temp directory, removed afterwards, never under data/.
  const directory = mkdtempSync(join(tmpdir(), "opspilot-"));
  after(() => rmSync(directory, { recursive: true, force: true }));

  const counts = (store: SqliteOpsStore) => {
    const state = store.getState();
    return [state.services.length, state.alerts.length, state.runbooks.length, state.incidents.length];
  };

  it("keeps the seed counts after opening 10 times", () => {
    const path = join(directory, "repeat.db");
    for (let i = 0; i < 10; i++) new SqliteOpsStore(path).close();
    const store = new SqliteOpsStore(path);
    assert.deepEqual(counts(store), [6, 7, 3, 0]);
    store.close();
  });

  it("keeps an incident across a restart and continues the id sequence", () => {
    const path = join(directory, "restart.db");
    const first = new SqliteOpsStore(path);
    const opened = first.openIncident({ title: "Checkout latency", service: "checkout-api", severity: "high" });
    first.close();

    const second = new SqliteOpsStore(path);
    const [listed] = second.listIncidents("all");
    assert.equal(listed?.id, opened.id);
    assert.equal(listed?.status, "open");
    assert.equal(
      second.openIncident({ title: "Another", service: "auth-service", severity: "low" }).id,
      "INC-002",
    );
    second.close();
  });

  it("does not reopen a seeded alert that was resolved after the seed", () => {
    const path = join(directory, "changed.db");
    const first = new SqliteOpsStore(path);
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE alerts SET status = ? WHERE id = ?").run("resolved", "ALT-001");
    raw.close();

    const reopened = new SqliteOpsStore(path);
    assert.equal(reopened.listAlerts("all").find((alert) => alert.id === "ALT-001")?.status, "resolved");
    assert.equal(reopened.listAlerts("firing").length, 3);
    reopened.close();
  });

  it("creates a missing nested directory when opening through openOpsStore", () => {
    const path = join(directory, "nested", "deeper", "ops.db");
    const store = openOpsStore({ OPSPILOT_DB: path });
    assert.deepEqual(counts(store), [6, 7, 3, 0]);
    store.close();
  });

  it("wraps a path under a regular file in StoreOpenError that names the path", () => {
    const file = join(directory, "plain-file");
    writeFileSync(file, "not a directory");
    const path = join(file, "x.db");
    assert.throws(
      () => openOpsStore({ OPSPILOT_DB: path }),
      (error: unknown) => error instanceof StoreOpenError && error.message.includes(path),
    );
  });

  it("throws on any call after close", () => {
    const store = new SqliteOpsStore(":memory:");
    store.close();
    assert.throws(() => store.listAlerts("all"));
  });
});
