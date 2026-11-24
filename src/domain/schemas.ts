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

export const Provider = z.enum(["github", "cloudflare"]);
export type Provider = z.infer<typeof Provider>;

export const CheckProviderStatusInput = z.object({
  provider: Provider.default("github").describe(
    "Which external provider to check: github (GitHub, including Actions, git pushes and webhooks) " +
      "or cloudflare (CDN, DNS and edge). Defaults to github.",
  ),
});
export type CheckProviderStatusInput = z.infer<typeof CheckProviderStatusInput>;

export const GetRunbookInput = z.object({
  service: z
    .string()
    .trim()
    .min(1)
    .describe("The exact service name, as list_alerts shows it, for example checkout-api."),
});

/** Who wrote a message: the engineer (`user`) or the copilot (`assistant`). A closed set. */
export const MessageRole = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const Conversation = z.object({
  id: z.string().min(1),
  /** ISO 8601 */
  createdAt: z.string().min(1),
});
export type Conversation = z.infer<typeof Conversation>;

/** What a caller appends. An answer may legitimately be an empty string, so there is no minimum length. */
export const NewMessage = z.object({
  role: MessageRole,
  content: z.string(),
});
export type NewMessage = z.infer<typeof NewMessage>;

export const StoredMessage = NewMessage.extend({
  /** Sets the order of the messages inside a conversation. */
  id: z.number().int(),
  conversationId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

/** Whoever the client says it is: there is no authentication. The memories table CHECK mirrors the limits. */
export const UserId = z.string().trim().min(1).max(128);
export type UserId = z.infer<typeof UserId>;

/** One lasting fact, one sentence or a short paragraph. The memories table CHECK mirrors the limits. */
export const MemoryFact = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("The fact in one short sentence, for example 'The payments team owns the checkout service'.");
export type MemoryFact = z.infer<typeof MemoryFact>;

export const MemoryId = z
  .number()
  .int()
  .positive()
  .describe("The N in [memory N] from the remembered facts at the top of the request.");
export type MemoryId = z.infer<typeof MemoryId>;

/** A stored fact. The embedding never leaves the store. */
export const Memory = z.object({
  id: MemoryId,
  userId: UserId,
  fact: MemoryFact,
  /** ISO 8601 */
  createdAt: z.string().min(1),
});
export type Memory = z.infer<typeof Memory>;

/** A memory returned by recall, with its similarity to the query. Built per request, never stored. */
export const RecalledMemory = Memory.extend({ score: z.number().min(-1.0001).max(1.0001) });
export type RecalledMemory = z.infer<typeof RecalledMemory>;

/** No user id on purpose: the tool acts on the user of the request (FR-017). */
export const RememberFactInput = z.object({ fact: MemoryFact });
export type RememberFactInput = z.infer<typeof RememberFactInput>;

/** No user id on purpose: the tool acts on the user of the request (FR-017). */
export const ForgetFactInput = z.object({ id: MemoryId });
export type ForgetFactInput = z.infer<typeof ForgetFactInput>;

/** `created: false` means an existing near-duplicate was returned and nothing new was stored. */
export const RememberResult = z.object({ memory: Memory, created: z.boolean() });
export type RememberResult = z.infer<typeof RememberResult>;
