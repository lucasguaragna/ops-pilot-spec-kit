import { withHistory } from "../agents/history.ts";
import { createStrategy } from "../agents/index.ts";
import type { NewMessage } from "../domain/schemas.ts";
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
 * Looks the strategy up, loads or starts the conversation, runs the strategy with the history under
 * the timeout, saves a completed exchange, and reports what happened.
 *
 * Throws UnknownStrategyError before anything is read or written, then ConversationNotFoundError for
 * an unknown id before the run starts, so a 422 or a 404 never creates a conversation.
 */
export async function runChat(settings: ResolvedSettings, request: ChatRequest): Promise<ChatOutcome> {
  const strategy = createStrategy(settings.registry, request.strategy, settings.createDependencies(), {
    reflect: request.reflect,
  });
  const { conversations } = settings;
  let conversationId: string;
  let history: NewMessage[] = [];
  if (request.conversationId === undefined) {
    conversationId = conversations.create().id;
  } else {
    conversationId = request.conversationId;
    history = conversations.lastMessages(conversationId, settings.historyLimit);
  }

  const outcome = await runTimed(settings, withHistory(strategy, history), request.message);

  // DatabaseSync is synchronous and there is no await between the two appends, so no other request
  // can slip in between them. A run that timed out saves nothing, even if it finishes late.
  for (const message of messagesToSave(request.message, outcome)) conversations.append(conversationId, message);

  return { ...outcome, conversation: { id: conversationId, historyMessages: history.length } };
}
