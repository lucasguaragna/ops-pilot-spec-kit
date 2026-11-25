import express, { type ErrorRequestHandler } from "express";
import type { StrategyDependencies } from "../agents/react.ts";
import type { StrategyRegistry } from "../agents/index.ts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createRouter, type Router } from "../graph/router.ts";
import type { MemoryStore } from "../memory/memory-store.ts";
import type { ConversationStore } from "../store/conversation-store.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { postChat } from "./chat-controller.ts";

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_ITERATIONS = 10;
/** The learning step gives up after this long (spec assumption: 30 s). */
export const LEARNING_TIMEOUT_MS = 30_000;
/** One history summarization gives up after this long. It also counts toward the request timeout, so a slow summary leaves the agent less time. */
export const SUMMARY_TIMEOUT_MS = 30_000;

export interface AppSettings {
  registry: StrategyRegistry;
  /** Builds the model and tools for one request. */
  createDependencies: () => StrategyDependencies;
  /** Required, so production can never fall back to a test double. */
  conversations: ConversationStore;
  /** Required, so production can never fall back to a test double. */
  memories: MemoryStore;
  /** Builds the router from the request's model. A test seam: tests plug in a fake router. */
  createRouter?: (model: BaseChatModel) => Router;
  timeoutMs?: number;
  maxIterations?: number;
  /** Holds the learning steps still running after their reply; tests await `settled()`. */
  background?: BackgroundTasks;
  /** How long one learning step may run. A test seam; production uses the default. */
  learningTimeoutMs?: number;
  /** How long one history summarization may run. A test seam; production uses the default. */
  summaryTimeoutMs?: number;
}

/** The settings with every default filled in. */
export type ResolvedSettings = Required<AppSettings>;

export function resolveSettings(settings: AppSettings): ResolvedSettings {
  return {
    createRouter: (model) => createRouter({ model }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    background: new BackgroundTasks(),
    learningTimeoutMs: LEARNING_TIMEOUT_MS,
    summaryTimeoutMs: SUMMARY_TIMEOUT_MS,
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
