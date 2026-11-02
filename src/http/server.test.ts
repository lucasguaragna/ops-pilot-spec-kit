import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { ScriptedChatModel, toolCallTurn } from "../testing/scripted-chat-model.ts";
import { VERDICT_TOOL_NAME } from "../agents/reflection.ts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StrategyRegistry } from "../agents/index.ts";
import type { ReasoningStrategy, RunOptions, RunResult } from "../domain/types.ts";
import { createApp, type AppSettings } from "./server.ts";

const servers: { close(): void }[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** Starts the app on a free port and returns its base URL. */
async function startServer(settings: AppSettings): Promise<string> {
  const server = createApp(settings).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface FakeStrategy extends ReasoningStrategy {
  calls: { input: string; options: RunOptions }[];
}

function fakeStrategy(name: string, result: RunResult | (() => Promise<RunResult>)): FakeStrategy {
  const calls: FakeStrategy["calls"] = [];
  return {
    name,
    calls,
    async run(input, options) {
      calls.push({ input, options });
      return typeof result === "function" ? result() : result;
    },
  };
}

const completed = (answer: string): RunResult => ({
  stopReason: "completed",
  answer,
  trace: [
    { type: "action", tool: "list_alerts", args: { status: "firing" } },
    { type: "observation", tool: "list_alerts", content: "[]" },
    { type: "answer", content: answer },
  ],
  metrics: { llmCalls: 2, latencyMs: 15 },
});

function settingsFor(strategies: Record<string, ReasoningStrategy>, extra: Partial<AppSettings> = {}): AppSettings {
  const registry: StrategyRegistry = Object.fromEntries(
    Object.entries(strategies).map(([name, strategy]) => [name, () => strategy]),
  );
  return { registry, createDependencies: () => ({ model: {} as BaseChatModel, tools: [] }), ...extra };
}

async function postChat(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe("POST /chat: successful runs", () => {
  it("runs react by default and replies 200 with answer, trace, and metrics", async () => {
    const react = fakeStrategy("react", completed("Two alerts are firing."));
    const baseUrl = await startServer(settingsFor({ react }));

    const { status, json } = await postChat(baseUrl, { message: "Which alerts are firing?", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, "Two alerts are firing.");
    assert.equal(json.stopReason, "completed");
    assert.equal(json.trace.length, 3);
    assert.deepEqual(json.metrics, { llmCalls: 2, latencyMs: 15 });
    assert.equal(react.calls.length, 1);
    assert.equal(react.calls[0]?.input, "Which alerts are firing?");
  });

  it("runs the strategy named in the body", async () => {
    const react = fakeStrategy("react", completed("from react"));
    const planExecute = fakeStrategy("plan-execute", completed("from plan"));
    const baseUrl = await startServer(settingsFor({ react, "plan-execute": planExecute }));

    const { status, json } = await postChat(baseUrl, { message: "hi", strategy: "plan-execute", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, "from plan");
    assert.equal(react.calls.length, 0);
  });

  it("replies 200 with a null answer at the iteration limit", async () => {
    const limited = fakeStrategy("react", {
      stopReason: "iteration_limit",
      answer: null,
      trace: [{ type: "thought", content: "still thinking" }],
      metrics: { llmCalls: 10, latencyMs: 99 },
    });
    const baseUrl = await startServer(settingsFor({ react: limited }));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(status, 200);
    assert.equal(json.answer, null);
    assert.equal(json.stopReason, "iteration_limit");
    assert.deepEqual(json.trace, [{ type: "thought", content: "still thinking" }]);
  });

  it("gives the strategy maxIterations 10", async () => {
    const react = fakeStrategy("react", completed("ok"));
    const baseUrl = await startServer(settingsFor({ react }));

    await postChat(baseUrl, { message: "hi", reflect: false });

    assert.equal(react.calls[0]?.options.maxIterations, 10);
  });
});

describe("POST /chat: reflection", () => {
  const withApprovingCritic = (react: ReasoningStrategy) =>
    settingsFor(
      { react },
      {
        createDependencies: () => ({
          model: new ScriptedChatModel([toolCallTurn(VERDICT_TOOL_NAME, { approved: true, feedback: "backed" })]),
          tools: [],
        }),
      },
    );

  it("adds a critique event to the trace when reflect is true", async () => {
    const baseUrl = await startServer(withApprovingCritic(fakeStrategy("react", completed("ok"))));

    const { status, json } = await postChat(baseUrl, { message: "hi", reflect: true });

    assert.equal(status, 200);
    assert.ok(json.trace.some((event: { type: string }) => event.type === "critique"));
  });

  it("leaves the trace without a critique when reflect is false", async () => {
    const baseUrl = await startServer(withApprovingCritic(fakeStrategy("react", completed("ok"))));

    const { json } = await postChat(baseUrl, { message: "hi", reflect: false });

    assert.ok(!json.trace.some((event: { type: string }) => event.type === "critique"));
  });
});

describe("routing", () => {
  it("replies 404 to GET /chat and POST /other", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    assert.equal((await fetch(`${baseUrl}/chat`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/other`, { method: "POST" })).status, 404);
  });
});

const validBody = { message: "hi", reflect: false };

async function postRaw(baseUrl: string, body?: string): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

describe("POST /chat: invalid requests", () => {
  const bad: [string, unknown, string][] = [
    ["missing message", { reflect: false }, "message"],
    ["blank message", { message: "   ", reflect: false }, "message"],
    ["missing reflect", { message: "hi" }, "reflect"],
    ["string reflect", { message: "hi", reflect: "true" }, "reflect"],
    ["numeric message", { message: 42, reflect: false }, "message"],
  ];
  for (const [label, body, field] of bad) {
    it(`replies 400 with an issue on ${field} for ${label}`, async () => {
      const react = fakeStrategy("react", completed("ok"));
      const baseUrl = await startServer(settingsFor({ react }));

      const { status, json } = await postChat(baseUrl, body);

      assert.equal(status, 400);
      assert.equal(json.error, "invalid_body");
      assert.ok(json.issues.some((issue: { path: unknown[] }) => issue.path[0] === field));
      assert.equal(react.calls.length, 0);
    });
  }

  it("replies 400 with one root issue for a body that is not JSON", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));

    const { status, json } = await postRaw(baseUrl, "not json");

    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
    assert.deepEqual(json.issues, [{ path: [], message: "The body is not valid JSON" }]);
  });

  it("replies 400 when the request has no body", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status, json } = await postRaw(baseUrl);
    assert.equal(status, 400);
    assert.equal(json.error, "invalid_body");
  });

  it("checks the body before the strategy name", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status } = await postChat(baseUrl, { strategy: "chain-of-thought" });
    assert.equal(status, 400);
  });

  it("ignores extra fields", async () => {
    const baseUrl = await startServer(settingsFor({ react: fakeStrategy("react", completed("ok")) }));
    const { status } = await postChat(baseUrl, { ...validBody, admin: true });
    assert.equal(status, 200);
  });
});

describe("POST /chat: unknown strategy", () => {
  for (const name of ["chain-of-thought", "React", "reflect:react", "toString"]) {
    it(`replies 422 for "${name}" and lists the known names`, async () => {
      const baseUrl = await startServer(
        settingsFor({ react: fakeStrategy("react", completed("a")), "plan-execute": fakeStrategy("plan-execute", completed("b")) }),
      );

      const { status, json } = await postChat(baseUrl, { ...validBody, strategy: name });

      assert.equal(status, 422);
      assert.equal(json.error, "unknown_strategy");
      assert.equal(json.strategy, name);
      assert.deepEqual(json.knownStrategies, ["react", "plan-execute"]);
    });
  }
});

describe("POST /chat: run failures", () => {
  it("replies 502 with the trace when the run returns an error result", async () => {
    const failing = fakeStrategy("react", {
      stopReason: "error",
      answer: null,
      error: { name: "Error", message: "Provider returned 503" },
      trace: [{ type: "thought", content: "trying" }],
      metrics: { llmCalls: 1, latencyMs: 5 },
    });
    const baseUrl = await startServer(settingsFor({ react: failing }));

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 502);
    assert.equal(json.error, "run_failed");
    assert.deepEqual(json.runError, { name: "Error", message: "Provider returned 503" });
    assert.deepEqual(json.trace, [{ type: "thought", content: "trying" }]);
  });

  it("replies 502 without a trace or a stack when the run throws", async () => {
    const throwing = fakeStrategy("react", async () => {
      throw new Error("kaboom");
    });
    const baseUrl = await startServer(settingsFor({ react: throwing }));

    const { status, text, json } = await postRaw(baseUrl, JSON.stringify(validBody));

    assert.equal(status, 502);
    assert.equal(json.runError.message, "kaboom");
    assert.equal("trace" in json, false);
    assert.ok(!text.includes("stack") && !text.includes(" at "));
  });

  it("replies 504 and aborts the run when it outlives the timeout", async () => {
    let seen: AbortSignal | undefined;
    const slow: ReasoningStrategy = {
      name: "react",
      run: (_input, options) => {
        seen = options.signal;
        return new Promise(() => {});
      },
    };
    const baseUrl = await startServer(settingsFor({ react: slow }, { timeoutMs: 50 }));
    const started = Date.now();

    const { status, json } = await postChat(baseUrl, validBody);

    assert.equal(status, 504);
    assert.deepEqual(json, { error: "timeout", message: "The run did not finish within 50 ms", timeoutMs: 50 });
    assert.equal(seen?.aborted, true);
    assert.ok(Date.now() - started < 50 + 1000);
  });
});
