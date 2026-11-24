import express, { type ErrorRequestHandler } from "express";
import type { StrategyDependencies } from "../agents/react.ts";
import { HISTORY_LIMIT } from "../agents/history.ts";
import type { StrategyRegistry } from "../agents/index.ts";
import type { MemoryStore } from "../memory/memory-store.ts";
import type { ConversationStore } from "../store/conversation-store.ts";
import { postChat } from "./chat-controller.ts";

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_ITERATIONS = 10;

export interface AppSettings {
  registry: StrategyRegistry;
  /** Builds the model and tools for one request. */
  createDependencies: () => StrategyDependencies;
  /** Required, so production can never fall back to a test double. */
  conversations: ConversationStore;
  /** Required, so production can never fall back to a test double. */
  memories: MemoryStore;
  timeoutMs?: number;
  maxIterations?: number;
  /** How many earlier messages reach the agent. */
  historyLimit?: number;
}

/** The settings with every default filled in. */
export type ResolvedSettings = Required<AppSettings>;

export function resolveSettings(settings: AppSettings): ResolvedSettings {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    historyLimit: HISTORY_LIMIT,
    ...settings,
  };
}

// Last resort: no stack and no error text reach the client (FR-011).
const internalError: ErrorRequestHandler = (error, _req, res, _next) => {
  // express.json() marks a body that is not JSON with this type; that is the client's mistake.
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({
      error: "invalid_body",
      message: "The request body is invalid",
      issues: [{ path: [], message: "The body is not valid JSON" }],
    });
    return;
  }
  res.status(500).json({ error: "internal", message: "Internal server error" });
};

export function createApp(settings: AppSettings): express.Express {
  const resolved = resolveSettings(settings);
  const app = express();
  app.use(express.json());
  app.post("/chat", postChat(resolved));
  app.use(internalError);
  return app;
}
