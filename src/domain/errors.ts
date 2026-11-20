/** Errors the model can recover from; tools return them as text instead of failing the run. */
export class DomainError extends Error {}

export class ServiceNotFoundError extends DomainError {
  /** Lists the known services so the model can retry with an exact name. */
  constructor(
    readonly service: string,
    readonly knownServices: readonly string[] = [],
  ) {
    const known = knownServices.length > 0 ? `. Known services: ${knownServices.join(", ")}` : "";
    super(`Service not found: ${service}${known}`);
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

/** The service exists but has no runbook. Lists the services that do, so the model can say so. */
export class RunbookNotFoundError extends DomainError {
  constructor(
    readonly service: string,
    readonly servicesWithRunbooks: readonly string[],
  ) {
    super(`No runbook for service: ${service}. Services with a runbook: ${servicesWithRunbooks.join(", ")}`);
    this.name = "RunbookNotFoundError";
  }
}

/** The database cannot be opened or created. Names the path and the reason, never file contents. */
export class StoreOpenError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot open database ${path}: ${reason}`);
    this.name = "StoreOpenError";
  }
}

/** Names the missing or invalid settings, never their values. */
export class ConfigurationError extends Error {
  constructor(readonly settings: readonly string[]) {
    super(`Missing or invalid setting: ${settings.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

/** A request named a strategy the registry does not have. Not a DomainError: the model never sees it. */
export class UnknownStrategyError extends Error {
  constructor(
    readonly strategy: string,
    readonly knownStrategies: readonly string[],
  ) {
    super(`Unknown strategy "${strategy}". Known: ${knownStrategies.join(", ")}`);
    this.name = "UnknownStrategyError";
  }
}

/** A request named a conversation the store does not have. Not a DomainError: the model never sees it. */
export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}
