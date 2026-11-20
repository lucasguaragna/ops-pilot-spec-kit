import { tool } from "@langchain/core/tools";
import { DomainError } from "../domain/errors.ts";
import {
  CheckProviderStatusInput,
  GetRunbookInput,
  ListAlertsInput,
  ListIncidentsInput,
  OpenIncidentInput,
  ResolveIncidentInput,
} from "../domain/schemas.ts";
import {
  checkProviderStatus,
  formatFailure,
  formatStatusLine,
  type CheckDeps,
} from "../providers/provider-status.ts";
import type { OpsStore } from "../store/ops-store.ts";

/** Domain errors go back to the model as text, so it can react and the run continues. */
function toToolText(action: () => unknown): string {
  try {
    return JSON.stringify(action());
  } catch (error) {
    if (error instanceof DomainError) return `Error: ${error.message}`;
    throw error;
  }
}

/** `deps` lets tests replace `fetch` and the per-attempt timeout; entry points omit it. */
export function createTools(store: OpsStore, deps: CheckDeps = {}) {
  const listAlerts = tool(async ({ status }) => toToolText(() => store.listAlerts(status)), {
    name: "list_alerts",
    description:
      "List monitoring alerts. Use when the on-call engineer asks what is firing, how the services " +
      "are doing, how the on-call shift is going, or which alert is the oldest. Returns an array of " +
      "alerts (id ALT-NNN, title, service, severity, status, firedAt); the oldest alert is the one " +
      "with the earliest firedAt. Never returns an error. This is also where exact service names " +
      "come from, for open_incident and get_runbook.",
    schema: ListAlertsInput,
  });

  const openIncident = tool(async (input) => toToolText(() => store.openIncident(input)), {
    name: "open_incident",
    description:
      "Open an incident for a service. Use it only when an alert needs follow-up and list_incidents " +
      "shows no open incident for that service and problem; never for questions or status checks. " +
      "All three fields are required, and the service must be an exact name from list_alerts. " +
      "Returns the new incident with its id (INC-NNN). Returns 'Error: ...' listing the known " +
      "services when the service does not exist.",
    schema: OpenIncidentInput,
  });

  const resolveIncident = tool(async ({ id, summary }) => toToolText(() => store.resolveIncident({ id, summary })), {
    name: "resolve_incident",
    description:
      "Resolve an open incident. Use when the engineer says an incident is fixed or asks to close " +
      "it. The id has the form INC-NNN; find it with list_incidents. summary is optional: what fixed " +
      "it. Returns the resolved incident with resolvedAt and summary. Returns 'Error: ...' when the " +
      "incident does not exist or is already resolved.",
    schema: ResolveIncidentInput,
  });

  const listIncidents = tool(async ({ status }) => toToolText(() => store.listIncidents(status)), {
    name: "list_incidents",
    description:
      "List incidents. Use when the engineer asks about incidents or the shift, before open_incident " +
      "to avoid duplicates, and to find an id for resolve_incident. status: open | resolved | all " +
      "(default open). Returns an array of incidents ordered by id (INC-NNN), each with title, " +
      "service, severity, status, resolvedAt and summary. Never returns an error.",
    schema: ListIncidentsInput,
  });

  const getRunbook = tool(async ({ service }) => toToolText(() => store.getRunbook(service)), {
    name: "get_runbook",
    description:
      "Get the runbook of a service. Use when the engineer asks how to handle or fix an alert or a " +
      "service. The service is the exact name from list_alerts. Returns { service, title, steps[] } " +
      "with ordered steps. Returns 'Error: ...' listing the known services when the service does " +
      "not exist, or listing the services that have a runbook when this one has none.",
    schema: GetRunbookInput,
  });

  // Not wrapped in toToolText: that helper re-throws non-domain errors, and this tool must never throw.
  const checkProviderStatusTool = tool(
    async ({ provider }) => {
      const result = await checkProviderStatus(provider, deps);
      return result.ok ? formatStatusLine(result.status) : formatFailure(provider, result.failure, result.attempts);
    },
    {
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
    },
  );

  return [listAlerts, openIncident, resolveIncident, listIncidents, getRunbook, checkProviderStatusTool] as const;
}
