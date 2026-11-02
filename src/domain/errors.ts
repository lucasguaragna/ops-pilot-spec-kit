/** Errors the model can recover from; tools return them as text instead of failing the run. */
export class DomainError extends Error {}

export class ServiceNotFoundError extends DomainError {
  constructor(readonly service: string) {
    super(`Service not found: ${service}`);
    this.name = "ServiceNotFoundError";
  }
}

export class IncidentNotFoundError extends DomainError {
  constructor(readonly incidentId: string) {
    super(`Incident not found: ${incidentId}`);
    this.name = "IncidentNotFoundError";
  }
}

export class IncidentAlreadyResolvedError extends DomainError {
  constructor(readonly incidentId: string) {
    super(`Incident already resolved: ${incidentId}`);
    this.name = "IncidentAlreadyResolvedError";
  }
}

/** Names the missing or invalid settings, never their values. */
export class ConfigurationError extends Error {
  constructor(readonly settings: readonly string[]) {
    super(`Missing or invalid setting: ${settings.join(", ")}`);
    this.name = "ConfigurationError";
  }
}
