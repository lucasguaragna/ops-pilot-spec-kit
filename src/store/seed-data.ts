import type { Alert, Service } from "../domain/schemas.ts";

export const seedServices: readonly Service[] = [
  { name: "checkout-api" },
  { name: "payments-worker" },
  { name: "auth-service" },
  { name: "search-api" },
  { name: "notification-service" },
];

export const seedAlerts: readonly Alert[] = [
  {
    id: "ALT-001",
    title: "p99 latency above 2s",
    service: "checkout-api",
    severity: "high",
    status: "firing",
  },
  {
    id: "ALT-002",
    title: "Queue backlog above 10k messages",
    service: "payments-worker",
    severity: "critical",
    status: "firing",
  },
  {
    id: "ALT-003",
    title: "Login error rate above 5%",
    service: "auth-service",
    severity: "medium",
    status: "firing",
  },
  {
    id: "ALT-004",
    title: "Index refresh slower than usual",
    service: "search-api",
    severity: "low",
    status: "resolved",
  },
  {
    id: "ALT-005",
    title: "Email provider timeouts",
    service: "notification-service",
    severity: "medium",
    status: "resolved",
  },
  {
    id: "ALT-006",
    title: "Pod restarts in a loop",
    service: "checkout-api",
    severity: "critical",
    status: "resolved",
  },
];
