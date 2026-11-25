import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SummarizationStep } from "../agents/history-summarizer.ts";
import type { NewMessage } from "../domain/schemas.ts";
import type { ReasoningStrategy, Route, RouteDecision, RunResult, TraceEvent } from "../domain/types.ts";
import { runProductionGraph, type ProductionGraphInput } from "./production-graph.ts";
import type { Router } from "./router.ts";

const metrics = (llmCalls: number, promptTokens: number | null = null) => ({ llmCalls, latencyMs: 1, promptTokens, modelUsed: null });
const done = (trace: TraceEvent[], llmCalls = 2, promptTokens: number | null = null): RunResult => ({
  stopReason: "completed",
  answer: "final",
  trace,
  metrics: metrics(llmCalls, promptTokens),
});

const TRACES: Record<Route, TraceEvent[]> = {
  react: [{ type: "thought", content: "look" }, { type: "answer", content: "final" }],
  "plan-execute": [{ type: "plan", steps: ["a", "b"] }, { type: "action", tool: "list_alerts", args: {} }, { type: "answer", content: "final" }],
  reflect: [
    { type: "answer", content: "draft" },
    { type: "critique", approved: false, fix: "rerun", content: "no" },
    { type: "answer", content: "final" },
    { type: "critique", approved: true, content: "ok" },
  ],
};

interface Harness {
  inputs: string[];
  built: Route[];
  routerCalls: string[];
  run: (overrides?: Partial<ProductionGraphInput>, config?: { step?: SummarizationStep; decision?: RouteDecision; strategy?: (route: Route) => ReasoningStrategy; signal?: AbortSignal }) => ReturnType<typeof runProductionGraph>;
}

function harness(decision: RouteDecision = { route: "react", reason: "quick", source: "router" }): Harness {
  const h: Harness = { inputs: [], built: [], routerCalls: [], run: async () => { throw new Error("unset"); } };
  h.run = (overrides = {}, config = {}) => {
    const router: Router = {
      route: async (input) => {
        h.routerCalls.push(input);
        return { decision: config.decision ?? decision, llmCalls: 1, promptTokens: 10, switches: [], modelUsed: null };
      },
    };
    const input: ProductionGraphInput = {
      message: "Which alerts fire?",
      override: undefined,
      recalled: [],
      verbatim: [],
      fallbackHistory: [],
      previousSummary: "",
      ...overrides,
    };
    return runProductionGraph(
      {
        router,
        maxIterations: 5,
        summarize: async () => config.step ?? { kind: "not_due" },
        strategyFor:
          config.strategy ??
          ((route) => {
            h.built.push(route);
            return {
              name: route,
              run: async (text) => {
                h.inputs.push(text);
                return done(TRACES[route], 3, 100);
              },
            };
          }),
      },
      input,
      { signal: config.signal },
    );
  };
  return h;
}

const nodes = (trace: readonly { node: string }[]) => trace.map((event) => event.node);

describe("runProductionGraph: one run per route", () => {
  for (const route of ["react", "plan-execute", "reflect"] as const) {
    it(`runs only the ${route} strategy after a route event`, async () => {
      const h = harness({ route, reason: "because", source: "router" });
      const { result, decision } = await h.run();
      assert.deepEqual(h.built, [route]);
      assert.equal(decision.route, route);
      assert.deepEqual(result.trace[0], { type: "route", route, reason: "because", source: "router", node: "router" });
      assert.equal(result.stopReason, "completed");
      assert.equal(result.answer, "final");
    });
  }

  it("puts plan events after the route event for plan-execute and critique events for reflect", async () => {
    const plan = await harness({ route: "plan-execute", reason: "r", source: "router" }).run();
    assert.deepEqual(plan.result.trace.map((event) => event.type).slice(0, 2), ["route", "plan"]);
    const reflect = await harness({ route: "reflect", reason: "r", source: "router" }).run();
    assert.ok(reflect.result.trace.findIndex((event) => event.type === "critique") > 0);
  });

  it("routes 6 requests, 2 per route, to the strategy the router chose", async () => {
    for (const route of ["react", "plan-execute", "reflect", "react", "plan-execute", "reflect"] as const) {
      const h = harness({ route, reason: "r", source: "router" });
      await h.run();
      assert.deepEqual(h.built, [route]);
    }
  });
});

describe("runProductionGraph: nodes on the trace", () => {
  it("tags every event, in graph order, with the final answer on response", async () => {
    const h = harness({ route: "plan-execute", reason: "r", source: "router" });
    const { result } = await h.run({}, { step: { kind: "stored", summary: "s", rendered: "Summary: s\n\n", absorbed: 8, droppedSecrets: 0, llmCalls: 1, promptTokens: 5, switches: [], modelUsed: null } });
    assert.deepEqual(nodes(result.trace), ["context", "router", "plan-execute", "plan-execute", "response"]);
    assert.deepEqual(result.trace[0], { type: "summarize", content: "Summary: s\n\n", absorbed: 8, node: "context" });
  });

  it("keeps rejected reflect drafts with reflect", async () => {
    const { result } = await harness({ route: "reflect", reason: "r", source: "router" }).run();
    assert.deepEqual(nodes(result.trace), ["router", "reflect", "reflect", "response", "reflect"]);
  });

  it("has no response event after an iteration limit", async () => {
    const h = harness();
    const { result } = await h.run({}, {
      strategy: () => ({
        name: "react",
        run: async () => ({ stopReason: "iteration_limit", answer: null, trace: [{ type: "thought", content: "t" }], metrics: metrics(2) }),
      }),
    });
    assert.equal(result.stopReason, "iteration_limit");
    assert.deepEqual(nodes(result.trace), ["router", "react"]);
  });
});

describe("runProductionGraph: override and fallback", () => {
  it("makes no router call for an override", async () => {
    const h = harness();
    const { result, decision } = await h.run({ override: "plan-execute" });
    assert.deepEqual(h.routerCalls, []);
    assert.deepEqual(h.built, ["plan-execute"]);
    assert.deepEqual(decision, { route: "plan-execute", reason: "Requested by the caller", source: "override" });
    assert.equal(result.metrics.llmCalls, 3);
  });

  it("runs react on a fallback decision", async () => {
    const h = harness();
    const { result } = await h.run({}, { decision: { route: "react", reason: "Router failed: invalid answer", source: "fallback" } });
    assert.deepEqual(h.built, ["react"]);
    assert.equal(result.trace[0]?.type === "route" && result.trace[0].source, "fallback");
  });
});

describe("runProductionGraph: context and metrics", () => {
  const verbatim: NewMessage[] = [{ role: "user", content: "new question" }];
  const fallbackHistory: NewMessage[] = [{ role: "user", content: "old question" }];

  it("gives the agent memories, the stored summary, and the verbatim messages", async () => {
    const h = harness();
    const step: SummarizationStep = { kind: "stored", summary: "s", rendered: "SUMMARY\n", absorbed: 8, droppedSecrets: 0, llmCalls: 1, promptTokens: 7, switches: [], modelUsed: null };
    const out = await h.run({ recalled: [{ id: 3, fact: "likes terse replies" }], verbatim, fallbackHistory, previousSummary: "OLD\n" }, { step });
    const text = h.inputs[0]!;
    assert.ok(text.indexOf("[memory 3]") < text.indexOf("SUMMARY"));
    assert.ok(text.indexOf("SUMMARY") < text.indexOf("new question"));
    assert.ok(text.endsWith("Current request: Which alerts fire?"));
    assert.equal(h.routerCalls[0], text);
    assert.deepEqual(out.history, verbatim);
    assert.equal(out.summaryText, "SUMMARY\n");
  });

  it("falls back to the previous summary and capped messages when nothing was stored", async () => {
    for (const step of [{ kind: "not_due" }, { kind: "failed", reason: "timeout", llmCalls: 1, promptTokens: null, switches: [], modelUsed: null }] as SummarizationStep[]) {
      const h = harness();
      const out = await h.run({ verbatim, fallbackHistory, previousSummary: "OLD\n" }, { step });
      assert.deepEqual(out.history, fallbackHistory);
      assert.equal(out.summaryText, "OLD\n");
      assert.ok(h.inputs[0]!.includes("old question") && !h.inputs[0]!.includes("new question"));
      assert.deepEqual(nodes(out.result.trace)[0], "router");
    }
  });

  it("sums the calls and tokens of the summarizer, the router, and the strategy", async () => {
    const h = harness();
    const step: SummarizationStep = { kind: "stored", summary: "s", rendered: "S\n", absorbed: 8, droppedSecrets: 0, llmCalls: 1, promptTokens: 5, switches: [], modelUsed: null };
    const { result } = await h.run({}, { step });
    assert.equal(result.metrics.llmCalls, 1 + 1 + 3);
    assert.equal(result.metrics.promptTokens, 5 + 10 + 100);
  });

  it("counts a failed summarization's calls but adds no summarize event", async () => {
    const { result } = await harness().run({}, { step: { kind: "failed", reason: "empty", llmCalls: 1, promptTokens: null, switches: [], modelUsed: null } });
    assert.equal(result.metrics.llmCalls, 1 + 1 + 3);
    assert.ok(!result.trace.some((event) => event.type === "summarize"));
  });
});

describe("runProductionGraph: errors", () => {
  it("returns a strategy error result as a result", async () => {
    const { result } = await harness().run({}, {
      strategy: () => ({
        name: "react",
        run: async () => ({ stopReason: "error", answer: null, error: { name: "Boom", message: "x" }, trace: [], metrics: metrics(1) }),
      }),
    });
    assert.equal(result.stopReason, "error");
  });

  it("rejects when a strategy throws", async () => {
    await assert.rejects(
      harness().run({}, { strategy: () => ({ name: "react", run: async () => { throw new Error("strategy blew up"); } }) }),
      /strategy blew up/,
    );
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    await assert.rejects(harness().run({}, { signal: controller.signal }));
  });
});

describe("runProductionGraph: model fallback", () => {
  const decision: RouteDecision = { route: "react", reason: "quick", source: "router" };
  const input: ProductionGraphInput = {
    message: "Which alerts fire?",
    override: undefined,
    recalled: [],
    verbatim: [],
    fallbackHistory: [],
    previousSummary: "",
  };
  const strategyAnswering = (modelUsed: string | null): ReasoningStrategy => ({
    name: "react",
    run: async () => ({ ...done(TRACES.react), metrics: { ...metrics(2), modelUsed } }),
  });
  const routerWith = (switches: { from: string; to: string; error: string }[], modelUsed: string | null): Router => ({
    route: async () => ({ decision, llmCalls: 2, promptTokens: null, switches, modelUsed }),
  });
  const runWith = (router: Router, strategy: ReasoningStrategy, step: SummarizationStep = { kind: "not_due" }) =>
    runProductionGraph(
      { router, maxIterations: 5, summarize: async () => step, strategyFor: () => strategy },
      input,
      {},
    );

  it("puts the router's fallback event, tagged router, before the route event", async () => {
    const { result } = await runWith(routerWith([{ from: "p", to: "f", error: "RateLimitError" }], "f"), strategyAnswering("p"));
    assert.deepEqual(result.trace.slice(0, 2), [
      { type: "fallback", from: "p", to: "f", error: "RateLimitError", node: "router" },
      { type: "route", ...decision, node: "router" },
    ]);
  });

  it("reports the model of the last call that got an answer", async () => {
    const { result } = await runWith(routerWith([{ from: "p", to: "f", error: "RateLimitError" }], "f"), strategyAnswering("p"));
    assert.equal(result.metrics.modelUsed, "p");
  });

  it("keeps the router's model when the strategy reports none", async () => {
    const { result } = await runWith(routerWith([], "f"), strategyAnswering(null));
    assert.equal(result.metrics.modelUsed, "f");
  });

  it("is null when no call got an answer", async () => {
    const { result } = await runWith(routerWith([], null), strategyAnswering(null));
    assert.equal(result.metrics.modelUsed, null);
  });

  it("tags the summarization's fallback event context, before the summarize event", async () => {
    const step: SummarizationStep = {
      kind: "stored",
      summary: "s",
      rendered: "S\n",
      absorbed: 8,
      droppedSecrets: 0,
      llmCalls: 2,
      promptTokens: null,
      switches: [{ from: "p", to: "f", error: "TimeoutError" }],
      modelUsed: "f",
    };
    const { result } = await runWith(routerWith([], null), strategyAnswering(null), step);
    assert.deepEqual(result.trace.slice(0, 2).map((event) => [event.node, event.type]), [
      ["context", "fallback"],
      ["context", "summarize"],
    ]);
    assert.equal(result.metrics.modelUsed, "f");
  });

  it("traces the fallback of a failed summarization step", async () => {
    const step: SummarizationStep = {
      kind: "failed",
      reason: "thrown",
      llmCalls: 2,
      promptTokens: null,
      switches: [{ from: "p", to: "f", error: "TimeoutError" }],
      modelUsed: null,
    };
    const { result } = await runWith(routerWith([], null), strategyAnswering(null), step);
    assert.deepEqual(result.trace.slice(0, 2).map((event) => [event.node, event.type]), [
      ["context", "fallback"],
      ["router", "route"],
    ]);
  });
});
