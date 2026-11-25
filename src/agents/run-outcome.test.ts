import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelUnavailableError } from "../domain/errors.ts";
import { toRunError } from "./run-outcome.ts";

describe("toRunError", () => {
  it("names a plain Error and keeps its message", () => {
    assert.deepEqual(toRunError(new TypeError("boom")), { name: "TypeError", message: "boom" });
  });

  it("wraps a non-Error value", () => {
    assert.deepEqual(toRunError("oops"), { name: "Error", message: "oops" });
  });

  it("carries the class name of the error a ModelUnavailableError wraps", () => {
    const error = new ModelUnavailableError("RateLimitError", new Error("provider text"));
    assert.deepEqual(toRunError(error), {
      name: "ModelUnavailableError",
      message: "No model could answer",
      cause: "RateLimitError",
    });
  });

  it("finds a ModelUnavailableError that agent middleware wrapped as a cause", () => {
    const wrapped = new Error("middleware failed", { cause: new ModelUnavailableError("TimeoutError") });
    assert.deepEqual(toRunError(wrapped), {
      name: "ModelUnavailableError",
      message: "No model could answer",
      cause: "TimeoutError",
    });
  });
});
