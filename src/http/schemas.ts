import { z } from "zod";
import { UserId } from "../domain/schemas.ts";

export const ChatRequest = z.object({
  message: z.string().trim().min(1),
  // Any string passes here; the registry decides whether the name exists (422, not 400).
  strategy: z.string().default("react"),
  reflect: z.boolean(),
  /** Continues an existing conversation; without it a new one starts. A malformed id is a 400. */
  conversationId: z.uuid().optional(),
  /** Whose memories to recall and save; without it the run has no memory. */
  userId: UserId.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

const Count = z.number().int().nonnegative();

export const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({ type: z.literal("action"), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("observation"), tool: z.string(), content: z.string() }),
  z.object({ type: z.literal("plan"), steps: z.array(z.string()) }),
  z.object({
    type: z.literal("critique"),
    approved: z.boolean(),
    fix: z.enum(["rerun", "rewrite"]).optional(),
    content: z.string(),
  }),
  z.object({ type: z.literal("answer"), content: z.string() }),
]);

/** Estimated tokens of the starting context per source; the total is their sum. */
export const ContextBreakdownSchema = z
  .object({ system: Count, tools: Count, history: Count, memories: Count, message: Count, total: Count })
  .refine((b) => b.total === b.system + b.tools + b.history + b.memories + b.message, {
    message: "total must equal the sum of the sources",
    path: ["total"],
  });

export const MetricsSchema = z.object({
  llmCalls: Count,
  latencyMs: Count,
  /** How many earlier messages the agent was given. HTTP-only: the domain Metrics type does not have it. */
  historyMessages: Count,
  /** How many remembered facts the agent was given (0 to 3). HTTP-only, like historyMessages. */
  recalledMemories: Count,
  /** Real input tokens the provider reported over every model call of the run; null when none did. */
  promptTokens: Count.nullable(),
  /** Estimates (characters / 4) of the starting context by source. HTTP-only, like historyMessages. */
  contextBreakdown: ContextBreakdownSchema,
});

export const ChatReply = z.object({
  conversationId: z.string().min(1),
  answer: z.string().nullable(),
  stopReason: z.enum(["completed", "iteration_limit"]),
  trace: z.array(TraceEventSchema),
  metrics: MetricsSchema,
});
export type ChatReply = z.infer<typeof ChatReply>;

const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() });
export type Issue = z.infer<typeof Issue>;

export const ErrorReply = z.discriminatedUnion("error", [
  z.object({ error: z.literal("invalid_body"), message: z.string(), issues: z.array(Issue) }),
  z.object({
    error: z.literal("unknown_strategy"),
    message: z.string(),
    strategy: z.string(),
    knownStrategies: z.array(z.string()),
  }),
  z.object({
    error: z.literal("run_failed"),
    message: z.string(),
    runError: z.object({ name: z.string(), message: z.string() }),
    conversationId: z.string().min(1),
    trace: z.array(TraceEventSchema).optional(),
    metrics: MetricsSchema.optional(),
  }),
  z.object({
    error: z.literal("timeout"),
    message: z.string(),
    timeoutMs: z.number(),
    conversationId: z.string().min(1),
  }),
  z.object({ error: z.literal("conversation_not_found"), message: z.string(), conversationId: z.string() }),
  z.object({ error: z.literal("internal"), message: z.string() }),
]);
export type ErrorReply = z.infer<typeof ErrorReply>;

/** Flattens a ZodError into the issue shape of the 400 reply. Symbol keys become strings. */
export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    message: issue.message,
  }));
}
