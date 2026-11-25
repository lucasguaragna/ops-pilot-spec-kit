export type TraceEvent =
  | { type: "thought"; content: string }
  | { type: "action"; tool: string; args: Record<string, unknown> }
  | { type: "observation"; tool: string; content: string }
  | { type: "plan"; steps: string[] }
  | { type: "critique"; approved: boolean; fix?: "rerun" | "rewrite"; content: string }
  | { type: "answer"; content: string }
  /** Added by the graph, never by a strategy: the history was summarized for this request. */
  | { type: "summarize"; content: string; absorbed: number }
  /** Added by the graph's router: which strategy runs, why, and who decided. */
  | { type: "route"; route: Route; reason: string; source: RouteSource };

/** The strategies the production graph can run. Each is also the name of its graph node. */
export type Route = "react" | "plan-execute" | "reflect";

/** Who decided the route: the router, the caller (override), or the fallback after a router failure. */
export type RouteSource = "router" | "override" | "fallback";

export interface RouteDecision {
  route: Route;
  reason: string;
  source: RouteSource;
}

/** The steps of the production graph. */
export type NodeName = "context" | "router" | Route | "response";

/** A trace event that says which graph node produced it. */
export type NodeTraceEvent = TraceEvent & { node: NodeName };

export interface Metrics {
  llmCalls: number;
  latencyMs: number;
  /**
   * Sum of `usage_metadata.input_tokens` over every model call of the run that finished and
   * reported usage. Null when none did.
   */
  promptTokens: number | null;
}

/** Plain data, not an Error instance, so results stay printable. Never holds a secret. */
export interface RunError {
  name: string;
  message: string;
}

export type StopReason = "completed" | "iteration_limit" | "error";

export type RunResult<E = TraceEvent> = { trace: E[]; metrics: Metrics } & (
  | { stopReason: "completed"; answer: string }
  | { stopReason: "iteration_limit"; answer: null }
  | { stopReason: "error"; answer: null; error: RunError }
);

export interface RunOptions {
  maxIterations: number;
  /** Once aborted, no new model or tool call starts. */
  signal?: AbortSignal;
}

export interface ReasoningStrategy {
  name: string;
  /** The system instructions of the strategy's first model call; measured as 0 when absent. */
  systemPrompt?: string;
  run(input: string, options: RunOptions): Promise<RunResult>;
}
