import {
  IncidentAlreadyResolvedError,
  IncidentNotFoundError,
  ServiceNotFoundError,
} from "../domain/errors.ts";
import type {
  Alert,
  AlertFilter,
  Incident,
  OpenIncidentInput,
  ResolveIncidentInput,
} from "../domain/schemas.ts";
import { filterIncidents, formatIncidentId, runbookFor, type OpsStore, type StoreState } from "./ops-store.ts";
import { seedAlerts, seedRunbooks, seedServices } from "./seed-data.ts";

export type { StoreState } from "./ops-store.ts";

export interface Transition {
  state: StoreState;
  incident: Incident;
}

export function createInitialState(): StoreState {
  return {
    services: seedServices,
    alerts: seedAlerts,
    incidents: [],
    runbooks: seedRunbooks,
    nextIncidentNumber: 1,
  };
}

export function listAlerts(state: StoreState, status: AlertFilter): Alert[] {
  return state.alerts.filter((alert) => status === "all" || alert.status === status);
}

export function openIncident(state: StoreState, input: OpenIncidentInput): Transition {
  if (!state.services.some((service) => service.name === input.service)) {
    throw new ServiceNotFoundError(
      input.service,
      state.services.map((service) => service.name),
    );
  }
  const incident: Incident = {
    id: formatIncidentId(state.nextIncidentNumber),
    title: input.title,
    service: input.service,
    severity: input.severity,
    status: "open",
    resolvedAt: null,
    summary: null,
  };
  return {
    state: {
      ...state,
      incidents: [...state.incidents, incident],
      nextIncidentNumber: state.nextIncidentNumber + 1,
    },
    incident,
  };
}

/** `now` is passed in so the transition stays pure. */
export function resolveIncident(state: StoreState, { id, summary }: ResolveIncidentInput, now: string): Transition {
  const current = state.incidents.find((incident) => incident.id === id);
  if (!current) throw new IncidentNotFoundError(id);
  if (current.status === "resolved") throw new IncidentAlreadyResolvedError(id);
  const incident: Incident = { ...current, status: "resolved", resolvedAt: now, summary: summary ?? null };
  return {
    state: {
      ...state,
      incidents: state.incidents.map((item) => (item.id === id ? incident : item)),
    },
    incident,
  };
}

/** Thin stateful holder over the pure transitions above. Used by the bench and the tests. */
export function createStore(options: { initial?: StoreState; now?: () => string } = {}): OpsStore {
  const now = options.now ?? (() => new Date().toISOString());
  let state = options.initial ?? createInitialState();
  const apply = (transition: Transition): Incident => {
    state = transition.state;
    return transition.incident;
  };
  return {
    getState: () => state,
    listAlerts: (status) => listAlerts(state, status),
    listIncidents: (status) => filterIncidents(state.incidents, status),
    getRunbook: (service) => runbookFor(state.services, state.runbooks, service),
    openIncident: (input) => apply(openIncident(state, input)),
    resolveIncident: (input) => apply(resolveIncident(state, input, now())),
    reset: () => {
      state = createInitialState();
    },
  };
}
