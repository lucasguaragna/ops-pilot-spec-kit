import { tool } from "@langchain/core/tools";
import { DomainError } from "../domain/errors.ts";
import { ListAlertsInput, OpenIncidentInput, ResolveIncidentInput } from "../domain/schemas.ts";
import type { Store } from "../store/in-memory-store.ts";

/** Domain errors go back to the model as text, so it can react and the run continues. */
function toToolText(action: () => unknown): string {
  try {
    return JSON.stringify(action());
  } catch (error) {
    if (error instanceof DomainError) return `Error: ${error.message}`;
    throw error;
  }
}

export function createTools(store: Store) {
  const listAlerts = tool(async ({ status }) => toToolText(() => store.listAlerts(status)), {
    name: "list_alerts",
    description:
      "List monitoring alerts. Use when the on-call engineer asks what is firing, how the services " +
      "are doing, or how the on-call shift is going. status: firing | resolved | all. Each alert has " +
      "firedAt, when it started firing; the oldest alert is the one with the earliest firedAt.",
    schema: ListAlertsInput,
  });

  const openIncident = tool(async (input) => toToolText(() => store.openIncident(input)), {
    name: "open_incident",
    description:
      "Open an incident for a service when an alert needs follow-up. Returns the incident and its " +
      "id. All three fields are required. title: a short summary of the problem. " +
      "service: the exact service name, as list_alerts shows it (for example checkout-api). " +
      "severity: low | medium | high | critical; sev1 is critical, sev2 high, sev3 medium, sev4 low.",
    schema: OpenIncidentInput,
  });

  const resolveIncident = tool(async ({ id }) => toToolText(() => store.resolveIncident(id)), {
    name: "resolve_incident",
    description: "Resolve an open incident by its id, for example INC-001.",
    schema: ResolveIncidentInput,
  });

  return [listAlerts, openIncident, resolveIncident] as const;
}
