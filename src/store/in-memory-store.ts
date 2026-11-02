import {
  IncidentAlreadyResolvedError,
  IncidentNotFoundError,
  ServiceNotFoundError,
} from "../domain/errors.ts";
import type { Alert, AlertFilter, Incident, OpenIncidentInput, Service } from "../domain/schemas.ts";
import { seedAlerts, seedServices } from "./seed-data.ts";

export interface StoreState {
  readonly services: readonly Service[];
  readonly alerts: readonly Alert[];
  readonly incidents: readonly Incident[];
  readonly nextIncidentNumber: number;
}

export interface Transition {
  state: StoreState;
  incident: Incident;
}

export function createInitialState(): StoreState {
  return { services: seedServices, alerts: seedAlerts, incidents: [], nextIncidentNumber: 1 };
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
    id: `INC-${String(state.nextIncidentNumber).padStart(3, "0")}`,
    title: input.title,
    service: input.service,
    severity: input.severity,
    status: "open",
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

export function resolveIncident(state: StoreState, id: string): Transition {
  const current = state.incidents.find((incident) => incident.id === id);
  if (!current) throw new IncidentNotFoundError(id);
  if (current.status === "resolved") throw new IncidentAlreadyResolvedError(id);
  const incident: Incident = { ...current, status: "resolved" };
  return {
    state: {
      ...state,
      incidents: state.incidents.map((item) => (item.id === id ? incident : item)),
    },
    incident,
  };
}

/** Where the store keeps its state between calls. */
export interface StoreBackend {
  load(): StoreState;
  save(state: StoreState): void;
}

export function createMemoryBackend(initial: StoreState = createInitialState()): StoreBackend {
  let state = initial;
  return {
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}

/** Thin stateful holder over the pure transitions above, used by the tools. */
export interface Store {
  getState(): StoreState;
  listAlerts(status: AlertFilter): Alert[];
  openIncident(input: OpenIncidentInput): Incident;
  resolveIncident(id: string): Incident;
  reset(): void;
}

export function createStore(backend: StoreBackend = createMemoryBackend()): Store {
  const apply = (transition: Transition): Incident => {
    backend.save(transition.state);
    return transition.incident;
  };
  return {
    getState: () => backend.load(),
    listAlerts: (status) => listAlerts(backend.load(), status),
    openIncident: (input) => apply(openIncident(backend.load(), input)),
    resolveIncident: (id) => apply(resolveIncident(backend.load(), id)),
    reset: () => backend.save(createInitialState()),
  };
}
