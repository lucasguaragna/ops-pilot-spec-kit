import { withHistory } from "../agents/history.ts";
import { createStrategy } from "../agents/index.ts";
import { withMemories } from "../agents/memories.ts";
import { createMemoryTools } from "../agents/memory-tools.ts";
import type { NewMessage, RecalledMemory } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";
import { messagesToSave, type ChatOutcome, type RunOutcome } from "./chat-reply.ts";
import type { ChatRequest } from "./schemas.ts";
import type { ResolvedSettings } from "./server.ts";

export type TimedRun<T> = { kind: "done"; value: T } | { kind: "thrown"; error: unknown } | { kind: "timeout" };

/**
 * Races a run against a timer. On timeout it aborts the signal it gave the run, so the run stops
 * starting new work, and resolves without waiting for it. The timer is always cleared.
 */
export async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<TimedRun<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedRun<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  // The async wrapper turns a synchronous throw into a rejection; the handlers keep a run that
  // fails after the timeout from becoming an unhandled rejection.
  const finished = (async () => run(controller.signal))().then(
    (value): TimedRun<T> => ({ kind: "done", value }),
    (error: unknown): TimedRun<T> => ({ kind: "thrown", error }),
  );
  try {
    return await Promise.race([finished, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the strategy under the timeout and reports what happened to the run. */
async function runTimed(
  settings: ResolvedSettings,
  strategy: ReasoningStrategy,
  message: string,
): Promise<RunOutcome> {
  const timed = await runWithTimeout(
    (signal) => strategy.run(message, { maxIterations: settings.maxIterations, signal }),
    settings.timeoutMs,
  );
  switch (timed.kind) {
    case "done":
      return { kind: "result", result: timed.value };
    case "thrown":
      return { kind: "thrown", error: timed.error };
    case "timeout":
      return { kind: "timeout", timeoutMs: settings.timeoutMs };
  }
}

/**
 * Looks the strategy up, loads the history, recalls the user's facts, starts the conversation if
 * needed, runs the strategy with both under the timeout, saves a completed exchange, and reports
 * what happened.
 *
 * Throws UnknownStrategyError before anything is read or written, then ConversationNotFoundError for
 * an unknown id, then EmbeddingError when recall fails. All three come before a new conversation is
 * created, so none of them leaves an empty conversation behind.
 */
export async function runChat(settings: ResolvedSettings, request: ChatRequest): Promise<ChatOutcome> {
  const { conversations, memories } = settings;
  const { userId } = request;
  const dependencies = settings.createDependencies();
  // The memory tools exist only for a known user, so the agent can never save a fact for nobody.
  const tools =
    userId === undefined ? dependencies.tools : [...dependencies.tools, ...createMemoryTools(memories, userId)];
  const strategy = createStrategy(settings.registry, request.strategy, { ...dependencies, tools }, {
    reflect: request.reflect,
  });

  const history: NewMessage[] =
    request.conversationId === undefined ? [] : conversations.lastMessages(request.conversationId, settings.historyLimit);
  // Recall runs outside the run timeout: the first call loads the model, which takes seconds.
  const recalled: RecalledMemory[] = userId === undefined ? [] : await memories.recall(userId, request.message);
  const conversationId = request.conversationId ?? conversations.create().id;

  const outcome = await runTimed(settings, withHistory(withMemories(strategy, recalled), history), request.message);

  // DatabaseSync is synchronous and there is no await between the two appends, so no other request
  // can slip in between them. A run that timed out saves nothing, even if it finishes late.
  for (const message of messagesToSave(request.message, outcome)) conversations.append(conversationId, message);

  return {
    ...outcome,
    conversation: { id: conversationId, historyMessages: history.length },
    recalledMemories: recalled.length,
  };
}
