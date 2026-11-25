import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../domain/errors.ts";
import { chatModelFor, createModel, fallbackModelOf, retryFailedCall } from "./model.ts";

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

  it("builds a temperature 0 model for OpenRouter whose own retries are off", () => {
    const model = chatModelFor({ OPENROUTER_API_KEY: secret }, "openai/gpt-4o-mini");
    assert.equal(model.model, "openai/gpt-4o-mini");
    assert.equal(model.temperature, 0);
    assert.deepEqual(model.modelKwargs, { provider: { require_parameters: true } });
    assert.equal((model as unknown as { caller: { maxRetries: number } }).caller.maxRetries, 0);
  });

  it("returns a model that binds tools and structured output, with or without a fallback", () => {
    for (const OPENROUTER_MODEL_FALLBACK of [undefined, "other/model"]) {
      const model = createModel({ OPENROUTER_API_KEY: secret, OPENROUTER_MODEL: "a/b", OPENROUTER_MODEL_FALLBACK });
      assert.equal(typeof model.bindTools, "function");
      assert.equal(typeof model.withStructuredOutput, "function");
    }
  });

  it("does not need a fallback to start (FR-002)", () => {
    for (const OPENROUTER_MODEL_FALLBACK of [undefined, "", "   ", " a/b "]) {
      assert.doesNotThrow(() =>
        createModel({ OPENROUTER_API_KEY: secret, OPENROUTER_MODEL: "a/b", OPENROUTER_MODEL_FALLBACK }),
      );
    }
  });

  it("still names a missing key only by field when a fallback is set", () => {
    assert.throws(
      () => createModel({ OPENROUTER_MODEL: "a/b", OPENROUTER_MODEL_FALLBACK: "c/d" }),
      (error: unknown) => error instanceof ConfigurationError && error.settings.join() === "OPENROUTER_API_KEY",
    );
  });
});

describe("fallbackModelOf", () => {
  const primary = "a/b";
  it("is undefined when missing, empty, whitespace, or the same as the primary", () => {
    for (const value of [undefined, "", "   ", "a/b", " a/b "]) {
      assert.equal(fallbackModelOf({ OPENROUTER_MODEL: primary, OPENROUTER_MODEL_FALLBACK: value?.trim() }), undefined);
    }
  });

  it("returns the name when it differs", () => {
    assert.equal(fallbackModelOf({ OPENROUTER_MODEL: primary, OPENROUTER_MODEL_FALLBACK: "c/d" }), "c/d");
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
