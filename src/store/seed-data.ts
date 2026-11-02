import type { Alert, Runbook, Service } from "../domain/schemas.ts";

export const seedServices: readonly Service[] = [
  { name: "checkout-api", tier: 1 },
  { name: "payments-worker", tier: 1 },
  { name: "auth-service", tier: 1 },
  { name: "search-api", tier: 2 },
  { name: "notification-service", tier: 3 },
  { name: "catalog-api", tier: 2 },
];

// The oldest firing alert is ALT-003, not the lowest id, so "the oldest" needs firedAt.
export const seedAlerts: readonly Alert[] = [
  {
    id: "ALT-001",
    title: "p99 latency above 2s",
    service: "checkout-api",
    severity: "high",
    status: "firing",
    firedAt: "2026-11-02T08:40:00Z",
  },
  {
    id: "ALT-002",
    title: "Queue backlog above 10k messages",
    service: "payments-worker",
    severity: "critical",
    status: "firing",
    firedAt: "2026-11-02T09:15:00Z",
  },
  {
    id: "ALT-003",
    title: "Login error rate above 5%",
    service: "auth-service",
    severity: "medium",
    status: "firing",
    firedAt: "2026-11-02T06:05:00Z",
  },
  {
    id: "ALT-004",
    title: "Index refresh slower than usual",
    service: "search-api",
    severity: "low",
    status: "resolved",
    firedAt: "2026-11-01T22:30:00Z",
  },
  {
    id: "ALT-005",
    title: "Email provider timeouts",
    service: "notification-service",
    severity: "medium",
    status: "resolved",
    firedAt: "2026-11-01T18:10:00Z",
  },
  {
    id: "ALT-006",
    title: "Pod restarts in a loop",
    service: "checkout-api",
    severity: "critical",
    status: "resolved",
    firedAt: "2026-11-01T14:00:00Z",
  },
  {
    id: "ALT-007",
    title: "Product page error rate above 3%",
    service: "catalog-api",
    severity: "high",
    status: "firing",
    firedAt: "2026-11-02T09:50:00Z",
  },
];

// Only the tier-1 services have a runbook; the rest exercise the "no runbook" error.
export const seedRunbooks: readonly Runbook[] = [
  {
    service: "checkout-api",
    title: "Checkout latency and pod restarts",
    steps: [
      "Check the p99 latency and error panels for checkout-api and note when they started rising.",
      "Look at the pod restart count; if pods restart in a loop, read the last crash log before anything else.",
      "If the latest deploy is under 1 hour old, roll it back and watch p99 for 10 minutes.",
      "If latency stays high, scale checkout-api to double its replicas and check the database connection pool.",
      "Open an incident with the evidence and page the checkout owner if p99 is still above 2s after 15 minutes.",
    ],
  },
  {
    service: "payments-worker",
    title: "Payments queue backlog",
    steps: [
      "Check the queue depth and the age of the oldest message in the payments queue.",
      "Confirm the workers are running and consuming; restart stuck workers one at a time.",
      "Check the payment provider status page for an outage or throttling.",
      "If the backlog keeps growing, add workers until the queue drains, and do not purge any message.",
    ],
  },
  {
    service: "auth-service",
    title: "Login error rate",
    steps: [
      "Check the login error rate by error code to see if it is credentials, timeouts or 5xx.",
      "For 5xx or timeouts, check the identity database and the session cache health.",
      "Compare with the latest deploy and config change; roll back if the timing matches.",
      "If only one client or region fails, check its rate limits and certificates before escalating.",
    ],
  },
];
