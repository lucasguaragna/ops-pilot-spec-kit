import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import {
  IncidentAlreadyResolvedError,
  IncidentNotFoundError,
  ServiceNotFoundError,
  StoreOpenError,
} from "../domain/errors.ts";
import {
  Alert,
  Incident,
  Runbook,
  Service,
  type AlertFilter,
  type IncidentFilter,
  type OpenIncidentInput,
  type ResolveIncidentInput,
} from "../domain/schemas.ts";
import { filterIncidents, formatIncidentId, runbookFor, type OpsStore, type StoreState } from "./ops-store.ts";
import { seedAlerts, seedRunbooks, seedServices } from "./seed-data.ts";

export const DEFAULT_DB_PATH = "./data/opspilot.db";

/**
 * The CHECK lists are literal text on purpose: they are the second line of defence, so they must
 * not move with the zod enums. A parity test keeps the two in step.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3))
) STRICT;

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) > 0),
  service TEXT NOT NULL REFERENCES services(name),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
  fired_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) > 0),
  service TEXT NOT NULL REFERENCES services(name),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolved_at TEXT,
  summary TEXT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND summary IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS runbooks (
  service TEXT PRIMARY KEY REFERENCES services(name),
  title TEXT NOT NULL CHECK (length(title) > 0),
  steps TEXT NOT NULL CHECK (json_valid(steps))
) STRICT;
`;

type Row = Record<string, unknown>;

// Every row is parsed with the domain schema, so a row edited by hand fails loudly.
export const toService = (row: Row): Service => Service.parse({ name: row.name, tier: row.tier });

export const toAlert = (row: Row): Alert =>
  Alert.parse({
    id: row.id,
    title: row.title,
    service: row.service,
    severity: row.severity,
    status: row.status,
    firedAt: row.fired_at,
  });

export const toIncident = (row: Row): Incident =>
  Incident.parse({
    id: row.id,
    title: row.title,
    service: row.service,
    severity: row.severity,
    status: row.status,
    resolvedAt: row.resolved_at,
    summary: row.summary,
  });

export const toRunbook = (row: Row): Runbook =>
  Runbook.parse({ service: row.service, title: row.title, steps: JSON.parse(String(row.steps)) });

/** SQLite behind `OpsStore`. Every value goes through a prepared statement; `exec` only sees constant text. */
export class SqliteOpsStore implements OpsStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  private readonly insertService: StatementSync;
  private readonly insertAlert: StatementSync;
  private readonly insertRunbook: StatementSync;
  private readonly selectServices: StatementSync;
  private readonly selectAlerts: StatementSync;
  private readonly selectIncidents: StatementSync;
  private readonly selectIncident: StatementSync;
  private readonly selectRunbooks: StatementSync;
  private readonly selectNextNumber: StatementSync;
  private readonly insertIncident: StatementSync;
  private readonly updateIncident: StatementSync;

  constructor(path: string, options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA);

      this.insertService = this.db.prepare("INSERT INTO services (name, tier) VALUES (?, ?) ON CONFLICT DO NOTHING");
      this.insertAlert = this.db.prepare(
        "INSERT INTO alerts (id, title, service, severity, status, fired_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      );
      this.insertRunbook = this.db.prepare(
        "INSERT INTO runbooks (service, title, steps) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      );
      this.selectServices = this.db.prepare("SELECT name, tier FROM services ORDER BY rowid");
      this.selectAlerts = this.db.prepare(
        "SELECT id, title, service, severity, status, fired_at FROM alerts WHERE ? = 'all' OR status = ? ORDER BY id",
      );
      this.selectIncidents = this.db.prepare(
        "SELECT id, title, service, severity, status, resolved_at, summary FROM incidents ORDER BY CAST(substr(id, 5) AS INTEGER)",
      );
      this.selectIncident = this.db.prepare(
        "SELECT id, title, service, severity, status, resolved_at, summary FROM incidents WHERE id = ?",
      );
      this.selectRunbooks = this.db.prepare("SELECT service, title, steps FROM runbooks ORDER BY rowid");
      this.selectNextNumber = this.db.prepare(
        "SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 0) + 1 AS next FROM incidents",
      );
      this.insertIncident = this.db.prepare(
        "INSERT INTO incidents (id, title, service, severity, status, resolved_at, summary) VALUES (?, ?, ?, ?, 'open', NULL, NULL)",
      );
      this.updateIncident = this.db.prepare(
        "UPDATE incidents SET status = 'resolved', resolved_at = ?, summary = ? WHERE id = ?",
      );

      this.transaction(() => this.seed());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getState(): StoreState {
    return {
      services: this.services(),
      alerts: this.listAlerts("all"),
      incidents: this.listIncidents("all"),
      runbooks: this.runbooks(),
      nextIncidentNumber: this.nextNumber(),
    };
  }

  listAlerts(status: AlertFilter): Alert[] {
    return this.selectAlerts.all(status, status).map(toAlert);
  }

  listIncidents(status: IncidentFilter): Incident[] {
    return filterIncidents(this.selectIncidents.all().map(toIncident), status);
  }

  getRunbook(service: string) {
    return runbookFor(this.services(), this.runbooks(), service);
  }

  openIncident({ title, service, severity }: OpenIncidentInput): Incident {
    return this.transaction(() => {
      const services = this.services();
      if (!services.some((item) => item.name === service)) {
        throw new ServiceNotFoundError(
          service,
          services.map((item) => item.name),
        );
      }
      const id = formatIncidentId(this.nextNumber());
      this.insertIncident.run(id, title, service, severity);
      return this.incident(id);
    });
  }

  resolveIncident({ id, summary }: ResolveIncidentInput): Incident {
    return this.transaction(() => {
      const row = this.selectIncident.get(id);
      if (!row) throw new IncidentNotFoundError(id);
      if (row.status === "resolved") throw new IncidentAlreadyResolvedError(id);
      this.updateIncident.run(this.now(), summary ?? null, id);
      return this.incident(id);
    });
  }

  reset(): void {
    this.transaction(() => {
      // Children first, so the foreign keys stay satisfied.
      this.db.exec("DELETE FROM incidents; DELETE FROM runbooks; DELETE FROM alerts; DELETE FROM services;");
      this.seed();
    });
  }

  private services(): Service[] {
    return this.selectServices.all().map(toService);
  }

  private runbooks(): Runbook[] {
    return this.selectRunbooks.all().map(toRunbook);
  }

  private nextNumber(): number {
    return Number(this.selectNextNumber.get()?.next ?? 1);
  }

  private incident(id: string): Incident {
    const row = this.selectIncident.get(id);
    if (!row) throw new IncidentNotFoundError(id);
    return toIncident(row);
  }

  /** Adds the seed rows that are missing and leaves existing rows alone (FR-004). Run inside a transaction. */
  private seed(): void {
    for (const { name, tier } of seedServices) this.insertService.run(name, tier);
    for (const a of seedAlerts) this.insertAlert.run(a.id, a.title, a.service, a.severity, a.status, a.firedAt);
    for (const r of seedRunbooks) this.insertRunbook.run(r.service, r.title, JSON.stringify(r.steps));
  }

  /** IMMEDIATE takes the write lock up front, so reading the next id and inserting it cannot interleave. */
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const DbPath = z.string().trim().min(1).optional().catch(undefined);

/** Pure: reads `OPSPILOT_DB` from the given env and falls back to the default when it is unset or blank. */
export function resolveDbPath(env: NodeJS.ProcessEnv): string {
  return DbPath.parse(env.OPSPILOT_DB) ?? DEFAULT_DB_PATH;
}

/** Creates the directory if needed and opens the store. Any failure becomes a `StoreOpenError` naming the path. */
export function openOpsStore(
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => string } = {},
): SqliteOpsStore {
  const path = resolveDbPath(env);
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    return new SqliteOpsStore(path, options);
  } catch (error) {
    throw new StoreOpenError(path, error instanceof Error ? error.message : String(error));
  }
}
