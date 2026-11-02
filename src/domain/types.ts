export type TraceEvent =
  | { type: "thought"; content: string }
  | { type: "action"; tool: string; args: Record<string, unknown> }
  | { type: "observation"; tool: string; content: string }
  | { type: "plan"; steps: string[] }
  | { type: "critique"; approved: boolean; fix?: "rerun" | "rewrite"; content: string }
  | { type: "answer"; content: string };

export interface Metrics {
  llmCalls: number;
  latencyMs: number;
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
}

export interface ReasoningStrategy {
  name: string;
  run(input: string, options: RunOptions): Promise<RunResult>;
}
