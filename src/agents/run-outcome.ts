import { ModelUnavailableError } from "../domain/errors.ts";
import type { RunError } from "../domain/types.ts";

// The limit error classes are not exported, so they are recognized by name.
const ITERATION_LIMIT_ERRORS = new Set(["ModelCallLimitMiddlewareError", "GraphRecursionError"]);

export function isIterationLimitError(error: unknown): boolean {
  return error instanceof Error && ITERATION_LIMIT_ERRORS.has(error.name);
}

/**
 * The model-unavailable error inside `error`. Agent middleware wraps what a model call throws in a
 * `MiddlewareError`, which keeps the original as `cause`, so the chain is followed a few links.
 */
function unavailableIn(error: unknown): ModelUnavailableError | undefined {
  for (let link = error, depth = 0; link instanceof Error && depth < 4; link = link.cause, depth++) {
    if (link instanceof ModelUnavailableError) return link;
  }
  return undefined;
}

export function toRunError(error: unknown): RunError {
  const unavailable = unavailableIn(error);
  if (unavailable) return { name: unavailable.name, message: unavailable.message, cause: unavailable.causeName };
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
