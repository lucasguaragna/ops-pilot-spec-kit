import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../domain/errors.ts";
import { createModel } from "./model.ts";

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
  });
});
