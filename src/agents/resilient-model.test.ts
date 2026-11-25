import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ModelUnavailableError } from "../domain/errors.ts";
import { providerError } from "../testing/provider-errors.ts";
import { hangingTurn, ScriptedChatModel, textTurn, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { createResilientModel } from "./resilient-model.ts";

const ask = [new HumanMessage("hi")];
const down = () => providerError(503, "InternalServerError", "PROVIDER-SECRET-TEXT");

function build(primaryTurns: ConstructorParameters<typeof ScriptedChatModel>[0], fallbackTurns?: typeof primaryTurns, attempts = 1) {
  const primary = new ScriptedChatModel(primaryTurns);
  const fallback = fallbackTurns === undefined ? undefined : new ScriptedChatModel(fallbackTurns);
  const model = createResilientModel({
    primary: { model: primary, name: "p" },
    fallback: fallback && { model: fallback, name: "f" },
    attempts,
  });
  return { model, primary, fallback };
}

describe("createResilientModel", () => {
  it("answers from the primary and never touches the fallback", async () => {
    const { model, fallback } = build([textTurn("from primary")], [textTurn("from fallback")]);
    assert.equal((await model.invoke(ask)).content, "from primary");
    assert.equal(fallback?.calls, 0);
  });

  it("sends the call to the fallback when the primary fails", async () => {
    const { model, primary, fallback } = build([down()], [textTurn("from fallback")]);
    assert.equal((await model.invoke(ask)).content, "from fallback");
    assert.equal(primary.calls, 1);
    assert.equal(fallback?.calls, 1);
  });

  it("retries the primary and keeps the fallback unused when the retry answers", async () => {
    const { model, primary, fallback } = build([providerError(429, "RateLimitError"), textTurn("retried")], [textTurn("fb")], 2);
    assert.equal((await model.invoke(ask)).content, "retried");
    assert.equal(primary.calls, 2);
    assert.equal(fallback?.calls, 0);
  });

  it("does not retry an error that retrying cannot fix, and goes straight to the fallback", async () => {
    const { model, primary, fallback } = build([providerError(400, "BadRequestError")], [textTurn("fb")], 3);
    assert.equal((await model.invoke(ask)).content, "fb");
    assert.equal(primary.calls, 1);
    assert.equal(fallback?.calls, 1);
  });

  it("tries the primary first again on the next call", async () => {
    const { model, primary, fallback } = build([down(), textTurn("primary is back")], [textTurn("fb")]);
    assert.equal((await model.invoke(ask)).content, "fb");
    assert.equal((await model.invoke(ask)).content, "primary is back");
    assert.equal(primary.calls, 2);
    assert.equal(fallback?.calls, 1);
  });

  it("starts no fallback when the signal is already aborted, and rethrows the abort", async () => {
    const { model, fallback } = build([down()], [textTurn("fb")]);
    const reason = new Error("timed out");
    await assert.rejects(model.invoke(ask, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
    assert.equal(fallback?.calls, 0);
  });

  it("starts no fallback when the signal aborts during the primary call", async () => {
    const { model, fallback } = build([hangingTurn()], [textTurn("fb")]);
    const controller = new AbortController();
    const call = model.invoke(ask, { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancelled"));
    await assert.rejects(call, (error) => !(error instanceof ModelUnavailableError));
    assert.equal(fallback?.calls, 0);
  });

  it("gives the fallback the same tools and tool choice", async () => {
    const { model, fallback } = build([down()], [toolCallTurn("list_alerts", {})]);
    const listAlerts = tool(async () => "[]", { name: "list_alerts", description: "d", schema: z.object({}) });
    const reply = await model.bindTools!([listAlerts], { tool_choice: "any" }).invoke(ask);
    assert.equal(reply.tool_calls?.[0]?.name, "list_alerts");
    assert.equal(fallback?.bound.length, 1);
    assert.deepEqual(fallback?.bound[0]?.kwargs, { tool_choice: "any" });
    assert.equal(fallback?.bound[0]?.tools.length, 1);
  });

  it("gives the fallback the same output schema", async () => {
    const { model, fallback } = build([down()], [toolCallTurn("pick", { color: "red" })]);
    const structured = model.withStructuredOutput(z.object({ color: z.string() }), {
      name: "pick",
      method: "functionCalling",
      includeRaw: true,
    });
    const result = await structured.invoke(ask);
    assert.deepEqual(result.parsed, { color: "red" });
    assert.equal(fallback?.calls, 1);
  });

  it("throws ModelUnavailableError naming the primary's error class when there is no fallback", async () => {
    const { model, primary } = build([providerError(429, "RateLimitError", "PROVIDER-SECRET-TEXT")]);
    await assert.rejects(model.invoke(ask), (error) => {
      assert.ok(error instanceof ModelUnavailableError);
      assert.equal(error.causeName, "RateLimitError");
      assert.doesNotMatch(error.message, /PROVIDER-SECRET-TEXT/);
      return true;
    });
    assert.equal(primary.calls, 1);
  });

  it("throws ModelUnavailableError naming the primary's error class when both models fail", async () => {
    const { model, fallback } = build([providerError(429, "RateLimitError")], [providerError(503, "InternalServerError")]);
    await assert.rejects(model.invoke(ask), (error) => error instanceof ModelUnavailableError && error.causeName === "RateLimitError");
    assert.equal(fallback?.calls, 1);
  });

  it("retries the fallback too, as the course example does", async () => {
    const { model, fallback } = build([down()], [providerError(429, "RateLimitError"), textTurn("fb retried")], 2);
    assert.equal((await model.invoke(ask)).content, "fb retried");
    assert.equal(fallback?.calls, 2);
  });
});
