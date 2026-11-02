# Contract: Tools

Each tool validates input with zod and returns JSON text to the model. A domain error is returned as
text with `Error:` first, so the model can react and the run continues. Field rules are in
[data-model.md](../data-model.md).

## list_alerts

- **Input**: `{ status?: "firing" | "resolved" | "all" }`, default `firing`
- **Output**: Array of alerts with that status, or every alert for `all`

## open_incident

- **Input**: `{ title: string, service: string, severity: Severity }`
- **Output**: The created incident, with status `open`
- **Errors**: `ServiceNotFoundError`, whose message lists the known services
- **Severity aliases** (in the description): sev1 `critical`, sev2 `high`, sev3 `medium`, sev4 `low`

## resolve_incident

- **Input**: `{ id: string }`
- **Output**: The incident, with status `resolved`
- **Errors**: `IncidentNotFoundError`, `IncidentAlreadyResolvedError`
