import { z } from "zod";

export const ChatRequest = z.object({
  message: z.string().trim().min(1),
  // Any string passes here; the registry decides whether the name exists (422, not 400).
  strategy: z.string().default("react"),
  reflect: z.boolean(),
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

export const MetricsSchema = z.object({ llmCalls: Count, latencyMs: Count });

export const ChatReply = z.object({
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
    trace: z.array(TraceEventSchema).optional(),
    metrics: MetricsSchema.optional(),
  }),
  z.object({ error: z.literal("timeout"), message: z.string(), timeoutMs: z.number() }),
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
