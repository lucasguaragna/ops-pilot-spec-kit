import type { Alert, Service } from "../domain/schemas.ts";

export const seedServices: readonly Service[] = [
  { name: "checkout-api" },
  { name: "payments-worker" },
  { name: "auth-service" },
  { name: "search-api" },
  { name: "notification-service" },
  { name: "catalog-api" },
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
