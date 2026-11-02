import { createStrategy } from "../agents/index.ts";
import type { ChatOutcome } from "./chat-reply.ts";
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

/**
 * Looks the strategy up, applies reflection, runs it under the timeout, and reports what happened.
 * An unknown strategy name throws UnknownStrategyError before the run starts.
 */
export async function runChat(settings: ResolvedSettings, request: ChatRequest): Promise<ChatOutcome> {
  const strategy = createStrategy(settings.registry, request.strategy, settings.createDependencies(), {
    reflect: request.reflect,
  });
  const timed = await runWithTimeout(
    (signal) => strategy.run(request.message, { maxIterations: settings.maxIterations, signal }),
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
