import { z } from "zod";

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const AlertStatus = z.enum(["firing", "resolved"]);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const IncidentStatus = z.enum(["open", "resolved"]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const Service = z.object({
  name: z.string().min(1),
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
});
export type Incident = z.infer<typeof Incident>;

export const AlertFilter = z.enum(["firing", "resolved", "all"]);
export type AlertFilter = z.infer<typeof AlertFilter>;

export const ListAlertsInput = z.object({
  status: AlertFilter.default("firing"),
});

export const OpenIncidentInput = z.object({
  title: z.string().trim().min(1),
  service: z.string().trim().min(1),
  severity: Severity,
});
export type OpenIncidentInput = z.infer<typeof OpenIncidentInput>;

export const ResolveIncidentInput = z.object({
  id: z.string().trim().min(1),
});
