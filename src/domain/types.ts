export type TraceEvent =
  | { type: "thought"; content: string }
  | { type: "action"; tool: string; args: Record<string, unknown> }
  | { type: "observation"; tool: string; content: string }
  | { type: "plan"; steps: string[] }
  | { type: "critique"; approved: boolean; fix?: "rerun" | "rewrite"; content: string }
  | { type: "answer"; content: string }
  /** Added by the service, never by a strategy: the history was summarized for this request. */
  | { type: "summarize"; content: string; absorbed: number };

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

export type RunResult = { trace: TraceEvent[]; metrics: Metrics } & (
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
