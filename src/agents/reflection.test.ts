import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReasoningStrategy, RunResult, TraceEvent } from "../domain/types.ts";
import { ScriptedChatModel, textTurn, toolCallTurn, withUsage, type ScriptedTurn } from "../testing/scripted-chat-model.ts";
import {
  nextStep,
  observationsOf,
  rerunInput,
  skippedReflection,
  VERDICT_TOOL_NAME,
  verdictSchema,
  withReflection,
  type Verdict,
} from "./reflection.ts";
import { providerError } from "../testing/provider-errors.ts";
import { createResilientModel } from "./resilient-model.ts";
import { STRUCTURED_ATTEMPTS } from "./structured-output.ts";

const verdict = (value: Partial<Verdict> & { approved: boolean }) =>
  toolCallTurn(VERDICT_TOOL_NAME, { feedback: "", ...value });
const approve = verdict({ approved: true, feedback: "Backed by the trace" });

const openTrace: TraceEvent[] = [
  { type: "action", tool: "open_incident", args: { service: "checkout-api" } },
  { type: "observation", tool: "open_incident", content: '{"id":"INC-001"}' },
  { type: "answer", content: "Opened INC-001" },
];

function completed(
  answer: string,
  trace: TraceEvent[] = [],
  llmCalls = 2,
  promptTokens: number | null = null,
): RunResult {
  return { stopReason: "completed", answer, trace, metrics: { llmCalls, latencyMs: 0, promptTokens, modelUsed: null } };
}

/** A strategy that returns scripted results in order, repeating the last, and records its inputs. */
function fakeStrategy(results: RunResult[]): ReasoningStrategy & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    name: "fake",
    inputs,
    async run(input) {
      inputs.push(input);
      const result = results[Math.min(inputs.length - 1, results.length - 1)];
      if (!result) throw new Error("fakeStrategy has no results");
      return result;
    },
  };
}

function reflect(results: RunResult[], criticTurns: ScriptedTurn[], maxReflections?: number) {
  const model = new ScriptedChatModel(criticTurns);
  const base = fakeStrategy(results);
  const strategy = withReflection(base, { model, maxReflections });
  return { model, base, result: strategy.run("Open an incident for checkout", { maxIterations: 10 }) };
}

const critiques = (trace: TraceEvent[]) => trace.filter((event) => event.type === "critique");

describe("verdictSchema", () => {
  it("accepts an approval without fix and a rejection with fix", () => {
    assert.ok(verdictSchema.safeParse({ approved: true, feedback: "" }).success);
    assert.ok(verdictSchema.safeParse({ approved: false, feedback: "x", fix: "rerun" }).success);
    assert.ok(verdictSchema.safeParse({ approved: false, feedback: "x", fix: "rewrite" }).success);
  });

  it("rejects a rejection without fix and an unknown fix", () => {
    assert.equal(verdictSchema.safeParse({ approved: false, feedback: "x" }).success, false);
    assert.equal(verdictSchema.safeParse({ approved: false, feedback: "x", fix: "retry" }).success, false);
  });
});

describe("observationsOf", () => {
  it("keeps only observations, in order, across attempts", () => {
    const second: TraceEvent = { type: "observation", tool: "list_alerts", content: "[]" };
    const trace: TraceEvent[] = [...openTrace, { type: "critique", approved: false, content: "x" }, second];
    assert.deepEqual(observationsOf(trace), [openTrace[1], second]);
  });
});

describe("nextStep", () => {
  const rejected = (fix: "rerun" | "rewrite"): Verdict => ({ approved: false, feedback: "x", fix });

  it("stops on approval", () => {
    assert.equal(nextStep({ approved: true, feedback: "" }, 0, 2), "stop");
  });

  it("follows the fix while regenerations remain", () => {
    assert.equal(nextStep(rejected("rerun"), 0, 2), "rerun");
    assert.equal(nextStep(rejected("rewrite"), 1, 2), "rewrite");
  });

  it("stops at the limit, including a limit of 0", () => {
    assert.equal(nextStep(rejected("rerun"), 2, 2), "stop");
    assert.equal(nextStep(rejected("rewrite"), 0, 0), "stop");
    assert.equal(nextStep(rejected("rerun"), 3, 2), "stop");
  });

  it("falls back to rerun when a rejection has no fix", () => {
    assert.equal(nextStep({ approved: false, feedback: "x" }, 0, 2), "rerun");
  });
});

describe("rerunInput", () => {
  it("holds the request, the feedback, and each action with its result", () => {
    const text = rerunInput("Open an incident for checkout", "Resolve it too", openTrace);
    assert.match(text, /Open an incident for checkout/);
    assert.match(text, /Resolve it too/);
    assert.match(text, /open_incident \{"service":"checkout-api"\} -> \{"id":"INC-001"\}/);
    assert.match(text, /do not repeat/i);
  });

  it("says so when no action was taken", () => {
    assert.match(rerunInput("List alerts", "Check first", []), /No actions were taken/);
  });
});

describe("withReflection", () => {
  it("names the strategy after its base and validates the limit at creation", () => {
    const model = new ScriptedChatModel([approve]);
    assert.equal(withReflection(fakeStrategy([completed("x")]), { model }).name, "reflect:fake");
    for (const maxReflections of [-1, 1.5]) {
      assert.throws(() => withReflection(fakeStrategy([completed("x")]), { model, maxReflections }));
    }
  });

  it("adds an approving critique and sums metrics", async () => {
    const { result } = reflect([completed("Opened INC-001", openTrace)], [approve]);
    const run = await result;
    assert.equal(run.stopReason, "completed");
    assert.equal(run.answer, "Opened INC-001");
    assert.deepEqual(run.trace, [
      ...openTrace,
      { type: "critique", approved: true, content: "Backed by the trace" },
    ]);
    assert.equal(run.metrics.llmCalls, 3);
  });

  it("keeps the answer when rejected with a limit of 0", async () => {
    const reject = verdict({ approved: false, feedback: "Wrong id", fix: "rewrite" });
    const { base, result } = reflect([completed("Opened INC-009", openTrace)], [reject], 0);
    const run = await result;
    assert.equal(run.stopReason, "completed");
    assert.equal(run.answer, "Opened INC-009");
    assert.deepEqual(critiques(run.trace), [
      { type: "critique", approved: false, fix: "rewrite", content: "Wrong id" },
    ]);
    assert.equal(base.inputs.length, 1);
  });

  it("returns an attempt that did not complete without a critique", async () => {
    const limited: RunResult = {
      stopReason: "iteration_limit",
      answer: null,
      trace: openTrace.slice(0, 2),
      metrics: { llmCalls: 4, latencyMs: 0, promptTokens: null, modelUsed: null },
    };
    const { model, result } = reflect([limited], [approve]);
    const run = await result;
    assert.equal(run.stopReason, "iteration_limit");
    assert.equal(critiques(run.trace).length, 0);
    assert.equal(run.metrics.llmCalls, 4);
    assert.equal(model.calls, 0);
  });

  it("keeps the answer when the critic returns no valid verdict on any attempt", async () => {
    const noFix = verdict({ approved: false, feedback: "x" });
    const { result } = reflect([completed("Opened INC-001", openTrace)], [noFix, textTurn("ok")]);
    const run = await result;
    assert.equal(run.stopReason, "completed");
    assert.equal(run.answer, "Opened INC-001");
    assert.deepEqual(run.trace, [
      ...openTrace,
      skippedReflection(new Error(`The critic returned no structured output after ${STRUCTURED_ATTEMPTS} attempts`)),
    ]);
    assert.equal(run.metrics.llmCalls, 2 + STRUCTURED_ATTEMPTS);
  });

  it("keeps the rejected answer when the rewrite call fails", async () => {
    const reject = verdict({ approved: false, feedback: "The id is INC-001", fix: "rewrite" });
    const { base, result } = reflect(
      [completed("Opened INC-009", openTrace)],
      [reject, new Error("provider down")],
    );
    const run = await result;
    assert.equal(run.stopReason, "completed");
    assert.equal(run.answer, "Opened INC-009");
    assert.equal(base.inputs.length, 1);
    assert.deepEqual(run.trace.at(-1), skippedReflection(new Error("provider down")));
    assert.equal(run.metrics.llmCalls, 2 + 2);
  });

  it("reruns the base with the feedback and the actions taken", async () => {
    const reject = verdict({ approved: false, feedback: "Resolve INC-001 too", fix: "rerun" });
    const resolved = completed("Resolved INC-001", [{ type: "answer", content: "Resolved INC-001" }], 3);
    const { base, result } = reflect([completed("Opened INC-001", openTrace), resolved], [reject, approve]);
    const run = await result;
    assert.equal(run.answer, "Resolved INC-001");
    assert.equal(base.inputs.length, 2);
    assert.match(base.inputs[1] ?? "", /Resolve INC-001 too/);
    assert.match(base.inputs[1] ?? "", /INC-001/);
    assert.deepEqual(
      run.trace.map((event) => event.type),
      ["action", "observation", "answer", "critique", "answer", "critique"],
    );
    assert.equal(run.metrics.llmCalls, 2 + 3 + 2);
  });

  it("rewrites the answer without rerunning the base", async () => {
    const reject = verdict({ approved: false, feedback: "The id is INC-001", fix: "rewrite" });
    const { base, result } = reflect(
      [completed("Opened INC-009", openTrace)],
      [reject, textTurn("Opened INC-001"), approve],
    );
    const run = await result;
    assert.equal(run.answer, "Opened INC-001");
    assert.equal(base.inputs.length, 1);
    assert.deepEqual(run.trace.slice(-2), [
      { type: "answer", content: "Opened INC-001" },
      { type: "critique", approved: true, content: "Backed by the trace" },
    ]);
    assert.equal(run.metrics.llmCalls, 2 + 3);
  });

  it("stops after the default limit of 2 regenerations", async () => {
    const reject = verdict({ approved: false, feedback: "Still wrong", fix: "rerun" });
    const { base, result } = reflect([completed("Opened INC-001", openTrace)], [reject]);
    const run = await result;
    assert.equal(run.stopReason, "completed");
    assert.equal(base.inputs.length, 3);
    assert.equal(critiques(run.trace).length, 3);
    assert.equal(run.metrics.llmCalls, 3 * 2 + 3);
  });

  it("stops when a rerun does not complete", async () => {
    const reject = verdict({ approved: false, feedback: "Resolve it", fix: "rerun" });
    const failed: RunResult = {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "provider down" },
      trace: [],
      metrics: { llmCalls: 1, latencyMs: 0, promptTokens: null, modelUsed: null },
    };
    const { result } = reflect([completed("Opened INC-001", openTrace), failed], [reject, approve]);
    const run = await result;
    assert.equal(run.stopReason, "error");
    assert.equal(critiques(run.trace).length, 1);
    assert.equal(run.metrics.llmCalls, 2 + 1 + 1);
  });
});

describe("withReflection: systemPrompt", () => {
  const model = new ScriptedChatModel([approve]);

  it("exposes the base strategy's system prompt", () => {
    const base = { ...fakeStrategy([completed("x")]), systemPrompt: "S" };
    assert.equal(withReflection(base, { model }).systemPrompt, "S");
  });

  it("has no systemPrompt key when the base has none", () => {
    assert.equal("systemPrompt" in withReflection(fakeStrategy([completed("x")]), { model }), false);
  });
});

describe("withReflection: prompt tokens", () => {
  it("adds the critic call's input tokens to the base attempt's", async () => {
    const critic = withUsage(approve, 40);
    const { result } = reflect([completed("Opened INC-001", openTrace, 2, 300)], [critic]);
    const run = await result;
    assert.equal(run.metrics.promptTokens, 340);
  });

  it("sums every attempt and every critic call across a rerun", async () => {
    const reject = withUsage(verdict({ approved: false, feedback: "Missing step", fix: "rerun" }), 40);
    const { result } = reflect(
      [completed("First", openTrace, 2, 300), completed("Second", openTrace, 2, 500)],
      [reject, withUsage(approve, 60)],
    );
    const run = await result;
    assert.equal(run.metrics.promptTokens, 300 + 40 + 500 + 60);
  });

  it("counts the rewrite call once, in the reflection counter", async () => {
    const reject = withUsage(verdict({ approved: false, feedback: "Wrong id", fix: "rewrite" }), 40);
    const { result } = reflect(
      [completed("Opened INC-009", openTrace, 2, 300)],
      [reject, withUsage(textTurn("Opened INC-001"), 70), withUsage(approve, 50)],
    );
    const run = await result;
    assert.equal(run.answer, "Opened INC-001");
    assert.equal(run.metrics.promptTokens, 300 + 40 + 70 + 50);
  });

  it("is null when nothing reported usage", async () => {
    const { result } = reflect([completed("Opened INC-001", openTrace)], [approve]);
    const run = await result;
    assert.equal(run.metrics.promptTokens, null);
  });

  it("does not change the answer, trace, or call count", async () => {
    const plain = await reflect([completed("Opened INC-001", openTrace)], [approve]).result;
    const measured = await reflect([completed("Opened INC-001", openTrace, 2, 300)], [withUsage(approve, 40)]).result;
    assert.equal(measured.answer, plain.answer);
    assert.deepEqual(measured.trace, plain.trace);
    assert.equal(measured.metrics.llmCalls, plain.metrics.llmCalls);
  });
});

describe("withReflection: abort signal", () => {
  const options = (signal: AbortSignal) => ({ maxIterations: 10, signal });

  it("hands the same signal to the base strategy", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base: ReasoningStrategy = {
      name: "fake",
      async run(_input, runOptions) {
        seen.push(runOptions.signal);
        return completed("ok");
      },
    };
    const controller = new AbortController();
    const strategy = withReflection(base, { model: new ScriptedChatModel([approve]) });

    await strategy.run("hi", options(controller.signal));

    assert.deepEqual(seen, [controller.signal]);
  });

  it("calls no critic when the base aborts and still returns a completed answer", async () => {
    const controller = new AbortController();
    const base: ReasoningStrategy = {
      name: "fake",
      async run() {
        controller.abort();
        return completed("late answer");
      },
    };
    const model = new ScriptedChatModel([approve]);

    const result = await withReflection(base, { model }).run("hi", options(controller.signal));

    assert.equal(result.stopReason, "error");
    assert.equal(model.calls, 0);
  });

  it("returns an error, not the kept answer, when the critic aborts and rejects", async () => {
    const controller = new AbortController();
    class AbortingCritic extends ScriptedChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(): Promise<never> {
        controller.abort();
        throw new Error("Request aborted");
      }
    }
    const strategy = withReflection(fakeStrategy([completed("answer")]), { model: new AbortingCritic([approve]) });

    const result = await strategy.run("hi", options(controller.signal));

    assert.equal(result.stopReason, "error");
    assert.equal(result.answer, null);
  });
});

describe("withReflection: model fallback", () => {
  const critic = (primary: ScriptedTurn[], fallback: ScriptedTurn[]) =>
    createResilientModel({
      primary: { model: new ScriptedChatModel(primary), name: "p" },
      fallback: { model: new ScriptedChatModel(fallback), name: "f" },
      attempts: 1,
    });

  it("puts the critic's fallback event before the critique and reports the fallback", async () => {
    const model = critic([providerError(429, "RateLimitError", "PROVIDER-SECRET-TEXT")], [approve]);
    const inner = completed("Opened INC-001", [{ type: "answer", content: "Opened INC-001" }], 2);
    const result = await withReflection(fakeStrategy([inner]), { model, maxReflections: 1 }).run("open", { maxIterations: 5 });

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.trace.map((event) => event.type), ["answer", "fallback", "critique"]);
    assert.equal(result.metrics.modelUsed, "f");
    assert.equal(result.metrics.llmCalls, 4);
    assert.doesNotMatch(JSON.stringify(result.trace), /PROVIDER-SECRET-TEXT/);
  });

  it("keeps the inner strategy's own fallback events and model when the critic needs none", async () => {
    const model = critic([approve], [approve]);
    const inner = completed("Opened INC-001", [{ type: "fallback", from: "p", to: "f", error: "RateLimitError" }, { type: "answer", content: "Opened INC-001" }], 3);
    inner.metrics.modelUsed = "f";
    const result = await withReflection(fakeStrategy([inner]), { model, maxReflections: 1 }).run("open", { maxIterations: 5 });

    assert.deepEqual(result.trace.map((event) => event.type), ["fallback", "answer", "critique"]);
    assert.equal(result.metrics.modelUsed, "p");
  });

  it("keeps the answer when the critic fails on every model, and still traces the switch", async () => {
    const down = () => providerError(503, "InternalServerError");
    const model = critic([down()], [down()]);
    const inner = completed("Opened INC-001", [{ type: "answer", content: "Opened INC-001" }]);
    const result = await withReflection(fakeStrategy([inner]), { model, maxReflections: 1 }).run("open", { maxIterations: 5 });

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.trace.map((event) => event.type), ["answer", "fallback", "thought"]);
  });
});
