import type { z } from "zod";
import { DomainError } from "../domain/errors.ts";
import {
  CheckProviderStatusInput,
  GetRunbookInput,
  ListAlertsInput,
  ListIncidentsInput,
  OpenIncidentInput,
  ResolveIncidentInput,
} from "../domain/schemas.ts";
import type { OpsStore } from "../store/ops-store.ts";

/**
 * The single source of truth for every tool: name, model-facing description, input schema and the
 * one store call it makes. The agent (LangChain) and the MCP server both read from here, so a
 * change shows up on both sides. No LangChain and no MCP import: each edge adds its own wrapper.
 */

/** What a tool call answers: the text the caller sees, and whether it is an error. */
export type ToolOutcome = { text: string; isError: boolean };

/** Domain errors go back as text, so the caller can react and the run continues. Anything else is re-thrown. */
export function runToolText(action: () => unknown): ToolOutcome {
  try {
    return { text: JSON.stringify(action()), isError: false };
  } catch (error) {
    if (error instanceof DomainError) return { text: `Error: ${error.message}`, isError: true };
    throw error;
  }
}

export const listAlertsDefinition = {
  name: "list_alerts",
  description:
    "List monitoring alerts. Use when the on-call engineer asks what is firing, how the services " +
    "are doing, how the on-call shift is going, or which alert is the oldest. Returns an array of " +
    "alerts (id ALT-NNN, title, service, severity, status, firedAt); the oldest alert is the one " +
    "with the earliest firedAt. Never returns an error. This is also where exact service names " +
    "come from, for open_incident and get_runbook.",
  schema: ListAlertsInput,
  run: (store: OpsStore, { status }: z.output<typeof ListAlertsInput>) => store.listAlerts(status),
} as const;

export const openIncidentDefinition = {
  name: "open_incident",
  description:
    "Open an incident for a service. Use it only when an alert needs follow-up and list_incidents " +
    "shows no open incident for that service and problem; never for questions or status checks. " +
    "All three fields are required, and the service must be an exact name from list_alerts. " +
    "Returns the new incident with its id (INC-NNN). Returns 'Error: ...' listing the known " +
    "services when the service does not exist.",
  schema: OpenIncidentInput,
  run: (store: OpsStore, input: z.output<typeof OpenIncidentInput>) => store.openIncident(input),
} as const;

export const resolveIncidentDefinition = {
  name: "resolve_incident",
  description:
    "Resolve an open incident. Use when the engineer says an incident is fixed or asks to close " +
    "it. The id has the form INC-NNN; find it with list_incidents. summary is optional: what fixed " +
    "it. Returns the resolved incident with resolvedAt and summary. Returns 'Error: ...' when the " +
    "incident does not exist or is already resolved.",
  schema: ResolveIncidentInput,
  run: (store: OpsStore, { id, summary }: z.output<typeof ResolveIncidentInput>) =>
    store.resolveIncident({ id, summary }),
} as const;

export const listIncidentsDefinition = {
  name: "list_incidents",
  description:
    "List incidents. Use when the engineer asks about incidents or the shift, before open_incident " +
    "to avoid duplicates, and to find an id for resolve_incident. status: open | resolved | all " +
    "(default open). Returns an array of incidents ordered by id (INC-NNN), each with title, " +
    "service, severity, status, resolvedAt and summary. Never returns an error.",
  schema: ListIncidentsInput,
  run: (store: OpsStore, { status }: z.output<typeof ListIncidentsInput>) => store.listIncidents(status),
} as const;

export const getRunbookDefinition = {
  name: "get_runbook",
  description:
    "Get the runbook of a service. Use when the engineer asks how to handle or fix an alert or a " +
    "service. The service is the exact name from list_alerts. Returns { service, title, steps[] } " +
    "with ordered steps. Returns 'Error: ...' listing the known services when the service does " +
    "not exist, or listing the services that have a runbook when this one has none.",
  schema: GetRunbookInput,
  run: (store: OpsStore, { service }: z.output<typeof GetRunbookInput>) => store.getRunbook(service),
} as const;

/** No `run`: the handler needs the HTTP `deps` and is async, so it stays in `createTools`. */
export const checkProviderStatusDefinition = {
  name: "check_provider_status",
  description:
    "Check the public status page of an external provider the team depends on (github or " +
    "cloudflare). Use when an outside cause is suspected: GitHub Actions, git pushes or webhooks " +
    "failing; CDN, DNS or edge errors; the engineer asks 'is it ours or the provider's?'; or a " +
    "dependency looks down. Not for internal services: use list_alerts and list_incidents for " +
    "those. provider defaults to github. Returns one line '<provider>: <indicator> - " +
    "<description>'; indicator none means operational, minor, major and critical mean degraded " +
    "to down. Returns 'Error: ...' when the status page cannot be reached or understood; then " +
    "the provider status is unknown.",
  schema: CheckProviderStatusInput,
} as const;

export const TOOL_DEFINITIONS = [
  listAlertsDefinition,
  openIncidentDefinition,
  resolveIncidentDefinition,
  listIncidentsDefinition,
  getRunbookDefinition,
  checkProviderStatusDefinition,
] as const;
