import type { AddressInfo } from "node:net";
import type { StrategyRegistry } from "../agents/index.ts";
import type { ReasoningStrategy, RouteDecision, RunOptions, RunResult } from "../domain/types.ts";
import type { Router } from "../graph/router.ts";
import { createApp, type AppSettings } from "../http/server.ts";
import { FakeConversationStore } from "./fake-conversation-store.ts";
import { FakeEmbedder } from "./fake-embedder.ts";
import { FakeMemoryStore } from "./fake-memory-store.ts";
import { NO_LEARNING } from "./learning-turns.ts";
import { ScriptedChatModel } from "./scripted-chat-model.ts";

/*
 * Test-only helpers to run the real Express app on a free port with fake strategies and fake
 * stores. They never touch OPSPILOT_DB or data/, and must never be wired into src/index.ts.
 */

const servers: { close(): void }[] = [];

/** Closes every server a test file started. Call it from the file's own `after`. */
export function closeServers(): void {
  for (const server of servers.splice(0)) server.close();
}

/** Starts the app on a free port and returns its base URL. */
export async function startServer(settings: AppSettings): Promise<string> {
  const server = createApp(settings).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface FakeStrategy extends ReasoningStrategy {
  calls: { input: string; options: RunOptions }[];
}

/** A strategy that records its calls and returns a result, or whatever the function returns. */
export function fakeStrategy(name: string, result: RunResult | (() => Promise<RunResult>)): FakeStrategy {
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

export interface FakeRouter extends Router {
  /** The input of each call, so a test can tell whether the router ran. */
  calls: string[];
}

/** A router that always decides the same route and spends `llmCalls` calls (0 keeps metrics unchanged). */
export function fakeRouter(
  decision: RouteDecision = { route: "react", reason: "Test router", source: "router" },
  llmCalls = 0,
): FakeRouter {
  const calls: string[] = [];
  return {
    calls,
    async route(input) {
      calls.push(input);
      return { decision, llmCalls, promptTokens: null, switches: [], modelUsed: null };
    },
  };
}

export const completed = (answer: string): RunResult => ({
  stopReason: "completed",
  answer,
  trace: [
    { type: "action", tool: "list_alerts", args: { status: "firing" } },
    { type: "observation", tool: "list_alerts", content: "[]" },
    { type: "answer", content: answer },
  ],
  metrics: { llmCalls: 2, latencyMs: 15, promptTokens: null, modelUsed: null },
});

/** App settings that serve the given strategies over fake stores and a model that learns nothing. */
export function settingsFor(
  strategies: Record<string, ReasoningStrategy>,
  extra: Partial<AppSettings> = {},
): AppSettings {
  const registry: StrategyRegistry = Object.fromEntries(
    Object.entries(strategies).map(([name, strategy]) => [name, () => strategy]),
  );
  return {
    registry,
    createRouter: () => fakeRouter(),
    // The fake strategies never call the model; only the learning step does, and it learns nothing.
    createDependencies: () => ({ model: new ScriptedChatModel([NO_LEARNING]), tools: [] }),
    conversations: new FakeConversationStore(),
    memories: new FakeMemoryStore({ embedder: new FakeEmbedder() }),
    ...extra,
  };
}

export async function postChat(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
