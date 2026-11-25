import type { LearningOutcome } from "../agents/learning-reflector.ts";
import { toRunError } from "../agents/run-outcome.ts";
import type { ContextBreakdown } from "../context/breakdown.ts";
import { addPromptTokens } from "../context/tokens.ts";
import type { ConversationNotFoundError, UnknownStrategyError } from "../domain/errors.ts";
import type { NewMessage } from "../domain/schemas.ts";
import type { Metrics, RunError, RunResult, TraceEvent } from "../domain/types.ts";
// Type-only, so the import cycle with chat-service.ts disappears at run time.
import type { TimedRun } from "./chat-service.ts";
import type { ChatReply, ErrorReply } from "./schemas.ts";

/** What happened to the run itself. */
export type RunOutcome =
  | { kind: "result"; result: RunResult }
  | { kind: "thrown"; error: unknown }
  | { kind: "timeout"; timeoutMs: number };

/** The conversation a request ran in, and how many earlier messages the agent was given. */
export interface ConversationInfo {
  id: string;
  historyMessages: number;
}

/**
 * What happened to a request once it reached the service, how many facts the agent was given, and
 * the estimated size of the context it started with.
 */
export type ChatOutcome = RunOutcome & {
  conversation: ConversationInfo;
  recalledMemories: number;
  context: ContextBreakdown;
};

/** The context counts every reply with metrics reports. */
const contextMetrics = (outcome: ChatOutcome) => ({
  historyMessages: outcome.conversation.historyMessages,
  recalledMemories: outcome.recalledMemories,
  contextBreakdown: outcome.context,
});

/**
 * What the summarization step did in one request. A failure is a value, not a throw: it never fails
 * the request. `llmCalls` and `promptTokens` are what the step spent, stored or not, because the
 * calls were paid for either way.
 */
export type SummarizationStep =
  | {
      kind: "stored";
      summary: string;
      /** `renderSummary(summary)`: exactly what the agent reads. */
      rendered: string;
      /** How many messages this summarization added to the coverage. */
      absorbed: number;
      droppedSecrets: number;
      llmCalls: number;
      promptTokens: number | null;
    }
  | {
      kind: "failed";
      reason: "thrown" | "timeout" | "empty" | "conflict";
      /** The error of a `thrown` step; unset for the other reasons. */
      error?: unknown;
      llmCalls: number;
      promptTokens: number | null;
    }
  | { kind: "not_due" };

/**
 * Pure: puts the summarization step into the run's outcome. Its calls and tokens join the metrics,
 * stored or failed. A stored step also puts a `summarize` event first in the trace, so the engineer
 * sees which request refreshed the summary. A run that threw or timed out has no trace or metrics
 * in its reply, so it passes through unchanged.
 */
export function withSummarization(outcome: RunOutcome, step: SummarizationStep): RunOutcome {
  if (step.kind === "not_due" || outcome.kind !== "result") return outcome;
  const { result } = outcome;
  const metrics = {
    ...result.metrics,
    llmCalls: result.metrics.llmCalls + step.llmCalls,
    promptTokens: addPromptTokens(result.metrics.promptTokens, step.promptTokens),
  };
  const trace: TraceEvent[] =
    step.kind === "stored"
      ? [{ type: "summarize", content: step.rendered, absorbed: step.absorbed }, ...result.trace]
      : result.trace;
  return { kind: "result", result: { ...result, trace, metrics } };
}

export interface HttpReply {
  status: number;
  body: ChatReply | ErrorReply;
}

const RUN_FAILED_MESSAGE = "The run stopped with an error";
const RUN_ERROR_MESSAGE = "The run failed; details are in the server log";

/** The error text can come from the model provider, so only its class name reaches the client. */
function runFailed(
  runError: RunError,
  outcome: ChatOutcome,
  partial?: { trace: TraceEvent[]; metrics: Metrics },
): HttpReply {
  return {
    status: 502,
    body: {
      error: "run_failed",
      message: RUN_FAILED_MESSAGE,
      runError: { name: runError.name, message: RUN_ERROR_MESSAGE },
      conversationId: outcome.conversation.id,
      ...(partial && {
        trace: partial.trace,
        metrics: { ...partial.metrics, ...contextMetrics(outcome) },
      }),
    },
  };
}

/** The error behind a 502, for the server log; undefined when the outcome is not a failure. */
export function failureOf(outcome: RunOutcome): RunError | undefined {
  if (outcome.kind === "thrown") return toRunError(outcome.error);
  if (outcome.kind === "result" && outcome.result.stopReason === "error") return outcome.result.error;
  return undefined;
}

/** Pure: picks the status and body for a finished request. Bodies never carry a stack. */
export function toHttpReply(outcome: ChatOutcome): HttpReply {
  const { conversation } = outcome;
  switch (outcome.kind) {
    case "result": {
      const { result } = outcome;
      if (result.stopReason === "error") {
        const { trace, metrics } = result;
        return runFailed(result.error, outcome, { trace, metrics });
      }
      return {
        status: 200,
        body: {
          conversationId: conversation.id,
          answer: result.answer,
          stopReason: result.stopReason,
          trace: result.trace,
          metrics: { ...result.metrics, ...contextMetrics(outcome) },
        },
      };
    }
    case "thrown":
      return runFailed(toRunError(outcome.error), outcome);
    case "timeout":
      return {
        status: 504,
        body: {
          error: "timeout",
          message: `The run did not finish within ${outcome.timeoutMs} ms`,
          timeoutMs: outcome.timeoutMs,
          conversationId: conversation.id,
        },
      };
  }
}

export function unknownStrategyReply(error: UnknownStrategyError): HttpReply {
  return {
    status: 422,
    body: {
      error: "unknown_strategy",
      message: error.message,
      strategy: error.strategy,
      knownStrategies: [...error.knownStrategies],
    },
  };
}

export function conversationNotFoundReply(error: ConversationNotFoundError): HttpReply {
  return {
    status: 404,
    body: { error: "conversation_not_found", message: error.message, conversationId: error.conversationId },
  };
}

/**
 * Pure: the two messages to save after a run, the engineer's first. Only a run that completed with
 * an answer is saved, so the history never holds a question without its answer.
 */
export function messagesToSave(message: string, outcome: RunOutcome): NewMessage[] {
  if (outcome.kind !== "result" || outcome.result.stopReason !== "completed") return [];
  return [
    { role: "user", content: message },
    { role: "assistant", content: outcome.result.answer },
  ];
}

/**
 * Pure: whether the learning step runs. Only a completed run of a known user is learned from, so a
 * retried request (after a limit, an error, or a timeout) is never learned twice.
 */
export function shouldLearn(userId: string | undefined, outcome: RunOutcome): boolean {
  return userId !== undefined && outcome.kind === "result" && outcome.result.stopReason === "completed";
}

export interface LogLine {
  stream: "log" | "warn" | "error";
  line: string;
}

/**
 * Pure: the log line for one learning step, or undefined when there is nothing to say. A fact the
 * step did not save may hold a secret, so no line ever carries fact text. `timeoutMs` is passed in
 * because the timeout case of `TimedRun` carries no duration.
 */
export function learningLogLine(
  userId: string,
  timed: TimedRun<LearningOutcome>,
  timeoutMs: number,
): LogLine | undefined {
  switch (timed.kind) {
    case "timeout":
      return { stream: "error", line: `Learning timed out after ${timeoutMs} ms for ${userId}` };
    case "thrown": {
      const { error } = timed;
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { stream: "error", line: `Learning failed for ${userId}: ${cause}` };
    }
    case "done": {
      const outcome = timed.value;
      switch (outcome.kind) {
        case "saved":
          return { stream: "log", line: `Learned [memory ${outcome.memory.id}] for ${userId}` };
        case "duplicate":
          return { stream: "log", line: `Learning already known as [memory ${outcome.memory.id}] for ${userId}` };
        case "skipped":
          return outcome.reason === "no_learning"
            ? undefined
            : { stream: "warn", line: `Learning skipped for ${userId}: ${outcome.reason}` };
      }
    }
  }
}

/**
 * Pure: the log line for one summarization step, or undefined when there is nothing to say. Items
 * may hold anything the conversation said, so no line ever carries item text. `timeoutMs` is passed
 * in because a failed step carries no duration.
 */
export function summaryLogLine(conversationId: string, step: SummarizationStep, timeoutMs: number): LogLine | undefined {
  switch (step.kind) {
    case "not_due":
      return undefined;
    case "stored": {
      const secrets = step.droppedSecrets > 0 ? `, ${step.droppedSecrets} lines dropped as secrets` : "";
      return { stream: "log", line: `Summarized ${step.absorbed} messages for conversation ${conversationId}${secrets}` };
    }
    case "failed":
      switch (step.reason) {
        case "timeout":
          return { stream: "error", line: `Summary timed out after ${timeoutMs} ms for conversation ${conversationId}` };
        case "thrown": {
          const { error } = step;
          const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          return { stream: "error", line: `Summary failed for conversation ${conversationId}: ${cause}` };
        }
        case "empty":
        case "conflict":
          return { stream: "warn", line: `Summary skipped for conversation ${conversationId}: ${step.reason}` };
      }
  }
}
