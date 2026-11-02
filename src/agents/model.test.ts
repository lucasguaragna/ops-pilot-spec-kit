import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../domain/errors.ts";
import { createModel, retryFailedCall } from "./model.ts";

const secret = "sk-or-test-secret";

describe("createModel", () => {
  it("names a missing setting without printing the key", () => {
    assert.throws(
      () => createModel({ OPENROUTER_API_KEY: secret }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.message.includes("OPENROUTER_MODEL") &&
        !error.message.includes(secret),
    );
  });

  it("names every missing setting", () => {
    assert.throws(
      () => createModel({}),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.settings.includes("OPENROUTER_API_KEY") &&
        error.settings.includes("OPENROUTER_MODEL"),
    );
  });

  it("builds a temperature 0 model for OpenRouter", () => {
    const model = createModel({ OPENROUTER_API_KEY: secret, OPENROUTER_MODEL: "openai/gpt-4o-mini" });
    assert.equal(model.model, "openai/gpt-4o-mini");
    assert.equal(model.temperature, 0);
    assert.deepEqual(model.modelKwargs, { provider: { require_parameters: true } });
  });
});

describe("retryFailedCall", () => {
  const withStatus = (status: number, message = `${status} Provider returned error`) =>
    Object.assign(new Error(message), { status });

  it("retries a busy-provider 429, server errors, and network errors", () => {
    assert.doesNotThrow(() => retryFailedCall(withStatus(429)));
    assert.doesNotThrow(() => retryFailedCall(withStatus(503)));
    assert.doesNotThrow(() => retryFailedCall(new Error("socket hang up")));
  });

  it("gives up on a daily quota, other client errors, and aborts", () => {
    assert.throws(() => retryFailedCall(withStatus(429, "Rate limit exceeded: free-models-per-day")));
    assert.throws(() => retryFailedCall(withStatus(401)));
    assert.throws(() => retryFailedCall(withStatus(404)));
    assert.throws(() => retryFailedCall(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
});
