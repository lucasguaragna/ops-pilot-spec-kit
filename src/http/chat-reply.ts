import { toRunError } from "../agents/run-outcome.ts";
import type { ConversationNotFoundError, UnknownStrategyError } from "../domain/errors.ts";
import type { NewMessage } from "../domain/schemas.ts";
import type { Metrics, RunError, RunResult, TraceEvent } from "../domain/types.ts";
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

/** What happened to a request once it reached the service, and how many facts the agent was given. */
export type ChatOutcome = RunOutcome & { conversation: ConversationInfo; recalledMemories: number };

/** The context counts every reply with metrics reports. */
const contextMetrics = (outcome: ChatOutcome) => ({
  historyMessages: outcome.conversation.historyMessages,
  recalledMemories: outcome.recalledMemories,
});

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
