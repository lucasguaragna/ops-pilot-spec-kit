import { z } from "zod";

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const AlertStatus = z.enum(["firing", "resolved"]);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const IncidentStatus = z.enum(["open", "resolved"]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

/** 1 critical, 2 important, 3 auxiliary. */
export const ServiceTier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type ServiceTier = z.infer<typeof ServiceTier>;

export const Service = z.object({
  name: z.string().min(1),
  tier: ServiceTier,
});
export type Service = z.infer<typeof Service>;

export const Alert = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  service: z.string().min(1),
  severity: Severity,
  status: AlertStatus,
  /** When the alert started firing, as an ISO 8601 UTC timestamp. */
  firedAt: z.iso.datetime(),
});
export type Alert = z.infer<typeof Alert>;

export const Incident = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  service: z.string().min(1),
  severity: Severity,
  status: IncidentStatus,
  /** When the incident was resolved. `null` while it is open. */
  resolvedAt: z.iso.datetime().nullable(),
  /** What fixed it. `null` while it is open, and when the resolver gave none. */
  summary: z.string().min(1).nullable(),
});
export type Incident = z.infer<typeof Incident>;

export const Runbook = z.object({
  service: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
});
export type Runbook = z.infer<typeof Runbook>;

export const AlertFilter = z.enum(["firing", "resolved", "all"]);
export type AlertFilter = z.infer<typeof AlertFilter>;

export const IncidentFilter = z.enum(["open", "resolved", "all"]);
export type IncidentFilter = z.infer<typeof IncidentFilter>;

export const ListAlertsInput = z.object({
  status: AlertFilter.default("firing").describe(
    "Which alerts to list: firing (still active), resolved (already cleared) or all. Defaults to firing.",
  ),
});

export const OpenIncidentInput = z.object({
  title: z.string().trim().min(1).describe("A short summary of the problem, for example 'Checkout p99 latency above 2s'."),
  service: z
    .string()
    .trim()
    .min(1)
    .describe("The exact service name, as list_alerts shows it, for example checkout-api."),
  severity: Severity.describe(
    "How bad it is: low | medium | high | critical. Map sev1 to critical, sev2 to high, sev3 to medium, sev4 to low.",
  ),
});
export type OpenIncidentInput = z.infer<typeof OpenIncidentInput>;

export const ResolveIncidentInput = z.object({
  id: z.string().trim().min(1).describe("The incident id in the form INC-NNN, for example INC-001. Get it from list_incidents."),
  summary: z.string().trim().min(1).optional().describe("What fixed it, in one short sentence. Optional."),
});
export type ResolveIncidentInput = z.infer<typeof ResolveIncidentInput>;

export const ListIncidentsInput = z.object({
  status: IncidentFilter.default("open").describe(
    "Which incidents to list: open (still being worked), resolved (already closed) or all. Defaults to open.",
  ),
});

export const GetRunbookInput = z.object({
  service: z
    .string()
    .trim()
    .min(1)
    .describe("The exact service name, as list_alerts shows it, for example checkout-api."),
});
