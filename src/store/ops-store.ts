import { RunbookNotFoundError, ServiceNotFoundError } from "../domain/errors.ts";
import type {
  Alert,
  AlertFilter,
  Incident,
  IncidentFilter,
  OpenIncidentInput,
  ResolveIncidentInput,
  Runbook,
  Service,
} from "../domain/schemas.ts";

export interface StoreState {
  readonly services: readonly Service[];
  readonly alerts: readonly Alert[];
  readonly incidents: readonly Incident[];
  readonly runbooks: readonly Runbook[];
  readonly nextIncidentNumber: number;
}

/** What the tools and the bench use. The memory store and `SqliteOpsStore` both implement it. */
export interface OpsStore {
  /** Full snapshot, used by the bench judge and tests. */
  getState(): StoreState;
  listAlerts(status: AlertFilter): Alert[];
  listIncidents(status: IncidentFilter): Incident[];
  /** Throws `ServiceNotFoundError` or `RunbookNotFoundError`. */
  getRunbook(service: string): Runbook;
  /** Throws `ServiceNotFoundError`. */
  openIncident(input: OpenIncidentInput): Incident;
  /** Throws `IncidentNotFoundError` or `IncidentAlreadyResolvedError`. */
  resolveIncident(input: ResolveIncidentInput): Incident;
  /** Back to the seed, with no incidents. */
  reset(): void;
}

export function formatIncidentId(n: number): string {
  return `INC-${String(n).padStart(3, "0")}`;
}

export function filterIncidents(incidents: readonly Incident[], filter: IncidentFilter): Incident[] {
  return incidents.filter((incident) => filter === "all" || incident.status === filter);
}

export function runbookFor(
  services: readonly Service[],
  runbooks: readonly Runbook[],
  service: string,
): Runbook {
  if (!services.some((item) => item.name === service)) {
    throw new ServiceNotFoundError(
      service,
      services.map((item) => item.name),
    );
  }
  const runbook = runbooks.find((item) => item.service === service);
  if (!runbook) {
    throw new RunbookNotFoundError(
      service,
      runbooks.map((item) => item.service),
    );
  }
  return runbook;
}
