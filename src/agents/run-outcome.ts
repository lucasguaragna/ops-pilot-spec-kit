import type { RunError } from "../domain/types.ts";

// The limit error classes are not exported, so they are recognized by name.
const ITERATION_LIMIT_ERRORS = new Set(["ModelCallLimitMiddlewareError", "GraphRecursionError"]);

export function isIterationLimitError(error: unknown): boolean {
  return error instanceof Error && ITERATION_LIMIT_ERRORS.has(error.name);
}

export function toRunError(error: unknown): RunError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
