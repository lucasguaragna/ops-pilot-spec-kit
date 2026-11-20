import { tool } from "@langchain/core/tools";
import {
  checkProviderStatus,
  formatFailure,
  formatStatusLine,
  type CheckDeps,
} from "../providers/provider-status.ts";
import type { OpsStore } from "../store/ops-store.ts";
import {
  checkProviderStatusDefinition,
  getRunbookDefinition,
  listAlertsDefinition,
  listIncidentsDefinition,
  openIncidentDefinition,
  resolveIncidentDefinition,
  runToolText,
} from "../tools/definitions.ts";

/** `deps` lets tests replace `fetch` and the per-attempt timeout; entry points omit it. */
export function createTools(store: OpsStore, deps: CheckDeps = {}) {
  const listAlerts = tool(async (input) => runToolText(() => listAlertsDefinition.run(store, input)).text, {
    name: listAlertsDefinition.name,
    description: listAlertsDefinition.description,
    schema: listAlertsDefinition.schema,
  });

  const openIncident = tool(async (input) => runToolText(() => openIncidentDefinition.run(store, input)).text, {
    name: openIncidentDefinition.name,
    description: openIncidentDefinition.description,
    schema: openIncidentDefinition.schema,
  });

  const resolveIncident = tool(async (input) => runToolText(() => resolveIncidentDefinition.run(store, input)).text, {
    name: resolveIncidentDefinition.name,
    description: resolveIncidentDefinition.description,
    schema: resolveIncidentDefinition.schema,
  });

  const listIncidents = tool(async (input) => runToolText(() => listIncidentsDefinition.run(store, input)).text, {
    name: listIncidentsDefinition.name,
    description: listIncidentsDefinition.description,
    schema: listIncidentsDefinition.schema,
  });

  const getRunbook = tool(async (input) => runToolText(() => getRunbookDefinition.run(store, input)).text, {
    name: getRunbookDefinition.name,
    description: getRunbookDefinition.description,
    schema: getRunbookDefinition.schema,
  });

  // Not wrapped in runToolText: that helper re-throws non-domain errors, and this tool must never throw.
  const checkProviderStatusTool = tool(
    async ({ provider }) => {
      const result = await checkProviderStatus(provider, deps);
      return result.ok ? formatStatusLine(result.status) : formatFailure(provider, result.failure, result.attempts);
    },
    {
      name: checkProviderStatusDefinition.name,
      description: checkProviderStatusDefinition.description,
      schema: checkProviderStatusDefinition.schema,
    },
  );

  return [listAlerts, openIncident, resolveIncident, listIncidents, getRunbook, checkProviderStatusTool] as const;
}
