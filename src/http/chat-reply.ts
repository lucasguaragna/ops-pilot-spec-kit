import { toRunError } from "../agents/run-outcome.ts";
import type { UnknownStrategyError } from "../domain/errors.ts";
import type { Metrics, RunError, RunResult, TraceEvent } from "../domain/types.ts";
import type { ChatReply, ErrorReply } from "./schemas.ts";

/** What happened to a request once it reached the service. */
export type ChatOutcome =
  | { kind: "result"; result: RunResult }
  | { kind: "thrown"; error: unknown }
  | { kind: "timeout"; timeoutMs: number };

export interface HttpReply {
  status: number;
  body: ChatReply | ErrorReply;
}

const RUN_FAILED_MESSAGE = "The run stopped with an error";
const RUN_ERROR_MESSAGE = "The run failed; details are in the server log";

/** The error text can come from the model provider, so only its class name reaches the client. */
function runFailed(runError: RunError, partial?: { trace: TraceEvent[]; metrics: Metrics }): HttpReply {
  return {
    status: 502,
    body: {
      error: "run_failed",
      message: RUN_FAILED_MESSAGE,
      runError: { name: runError.name, message: RUN_ERROR_MESSAGE },
      ...partial,
    },
  };
}

/** The error behind a 502, for the server log; undefined when the outcome is not a failure. */
export function failureOf(outcome: ChatOutcome): RunError | undefined {
  if (outcome.kind === "thrown") return toRunError(outcome.error);
  if (outcome.kind === "result" && outcome.result.stopReason === "error") return outcome.result.error;
  return undefined;
}

/** Pure: picks the status and body for a finished request. Bodies never carry a stack. */
export function toHttpReply(outcome: ChatOutcome): HttpReply {
  switch (outcome.kind) {
    case "result": {
      const { result } = outcome;
      if (result.stopReason === "error") {
        const { trace, metrics } = result;
        return runFailed(result.error, { trace, metrics });
      }
      return {
        status: 200,
        body: { answer: result.answer, stopReason: result.stopReason, trace: result.trace, metrics: result.metrics },
      };
    }
    case "thrown":
      return runFailed(toRunError(outcome.error));
    case "timeout":
      return {
        status: 504,
        body: {
          error: "timeout",
          message: `The run did not finish within ${outcome.timeoutMs} ms`,
          timeoutMs: outcome.timeoutMs,
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
