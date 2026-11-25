import { historyBlock, MAX_VERBATIM, planHistory, withHistory } from "../agents/history.ts";
import { cleanSummary, createHistorySummarizer, renderSummary } from "../agents/history-summarizer.ts";
import { LlmCallCounter } from "../agents/llm-counter.ts";
import { createLearningReflector, type LearningOutcome } from "../agents/learning-reflector.ts";
import { createStrategy } from "../agents/index.ts";
import { memoryBlock, withMemories } from "../agents/memories.ts";
import { createMemoryTools } from "../agents/memory-tools.ts";
import { contextBreakdown, toolDefinitionsText } from "../context/breakdown.ts";
import type { ConversationSummary, NewMessage, RecalledMemory } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";
import type { StrategyDependencies } from "../agents/react.ts";
import {
  learningLogLine,
  messagesToSave,
  shouldLearn,
  summaryLogLine,
  withSummarization,
  type ChatOutcome,
  type RunOutcome,
  type SummarizationStep,
} from "./chat-reply.ts";
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

/** Writes the learning step's line to the matching console stream; nothing for a quiet outcome. */
function logLearning(userId: string, timed: TimedRun<LearningOutcome>, timeoutMs: number): void {
  const logLine = learningLogLine(userId, timed, timeoutMs);
  if (logLine) console[logLine.stream](logLine.line);
}

/**
 * Summarizes the messages that left the window into the stored summary: one plain model call
 * under its own timeout, cleaned, then saved with a compare-and-swap on the coverage. Every failure
 * (thrown, timeout, nothing usable, a lost swap) is a `failed` step, never a throw, so it can never
 * fail a request. The calls the step made are counted either way.
 */
async function summarize(
  settings: ResolvedSettings,
  model: StrategyDependencies["model"],
  conversationId: string,
  previous: ConversationSummary | undefined,
  toSummarize: readonly NewMessage[],
): Promise<SummarizationStep> {
  const counter = new LlmCallCounter();
  const summarizer = createHistorySummarizer({ model });
  const timed = await runWithTimeout(
    (signal) => summarizer.summarize(previous?.summary, toSummarize, { signal, callbacks: [counter] }),
    settings.summaryTimeoutMs,
  );
  // The calls that started count, and their tokens count where the provider reported usage.
  const spent = { llmCalls: counter.count, promptTokens: counter.promptTokens };
  if (timed.kind === "timeout") return { kind: "failed", reason: "timeout", ...spent };
  if (timed.kind === "thrown") return { kind: "failed", reason: "thrown", error: timed.error, ...spent };

  const cleaned = cleanSummary(timed.value);
  if (cleaned === undefined) return { kind: "failed", reason: "empty", ...spent };

  const covered = previous?.coveredMessages ?? 0;
  try {
    const saved = settings.conversations.saveSummary(conversationId, cleaned.summary, covered, covered + toSummarize.length);
    if (!saved) return { kind: "failed", reason: "conflict", ...spent };
  } catch (error) {
    return { kind: "failed", reason: "thrown", error, ...spent };
  }
  return {
    kind: "stored",
    summary: cleaned.summary,
    rendered: renderSummary(cleaned.summary),
    absorbed: toSummarize.length,
    droppedSecrets: cleaned.droppedSecrets,
    ...spent,
  };
}

/**
 * Looks the strategy up, loads the history, recalls the user's facts, summarizes the history when a
 * batch is due, starts the conversation if needed, runs the strategy with all of it under the
 * timeout, saves a completed exchange, and reports what happened.
 *
 * The agent gets the user's facts, then the conversation summary, then the messages the summary does
 * not cover (8 to 14, word for word), then the request. A summarization happens only on a batch
 * boundary (see `planHistory`), runs after recall under its own timeout, and never fails the
 * request: if it fails, the agent gets the previous summary and the newest 14 uncovered messages.
 *
 * After the save, a completed run of a known user starts the learning step in the background. It is
 * tracked in `settings.background` and never awaited here, so the reply never waits for it; it
 * cannot reject, and its outcome only reaches the log.
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

  // The summary stands for the oldest messages; the rest are the "uncovered" ones. Both reads throw
  // ConversationNotFoundError for an unknown id, before anything is created.
  const previous = request.conversationId === undefined ? undefined : conversations.summaryOf(request.conversationId);
  const uncovered: NewMessage[] =
    request.conversationId === undefined
      ? []
      : conversations.messagesAfter(request.conversationId, previous?.coveredMessages ?? 0);
  const plan = planHistory(uncovered);
  // Recall runs outside the run timeout: the first call loads the model, which takes seconds.
  const recalled: RecalledMemory[] = userId === undefined ? [] : await memories.recall(userId, request.message);

  // Due only for an existing conversation, because it needs older messages. After recall, so a failed
  // recall wastes no model call; before the run, so the agent reads the new summary.
  const step: SummarizationStep =
    request.conversationId !== undefined && plan.toSummarize.length > 0
      ? await summarize(settings, dependencies.model, request.conversationId, previous, plan.toSummarize)
      : { kind: "not_due" };
  const logLine = summaryLogLine(request.conversationId ?? "", step, settings.summaryTimeoutMs);
  if (logLine) console[logLine.stream](logLine.line);

  // A stored summary covers the messages it absorbed; after a failure the previous one stands, and the
  // uncovered messages are capped so a provider outage cannot grow the context.
  const stored = step.kind === "stored";
  const history = stored ? plan.verbatim : plan.toSummarize.length > 0 ? uncovered.slice(-MAX_VERBATIM) : plan.verbatim;
  const summaryText = stored ? step.rendered : previous === undefined ? "" : renderSummary(previous.summary);
  const conversationId = request.conversationId ?? conversations.create().id;

  const outcome = withSummarization(
    await runTimed(settings, withHistory(withMemories(strategy, recalled), history, summaryText), request.message),
    step,
  );

  // DatabaseSync is synchronous and there is no await between the two appends, so no other request
  // can slip in between them. A run that timed out saves nothing, even if it finishes late.
  for (const message of messagesToSave(request.message, outcome)) conversations.append(conversationId, message);

  if (userId !== undefined && shouldLearn(userId, outcome)) {
    // The step's model calls go through no LlmCallCounter, so the reply's metrics stay the same.
    const reflector = createLearningReflector({ model: dependencies.model, memories });
    const { learningTimeoutMs } = settings;
    settings.background.track(
      runWithTimeout((signal) => reflector.learn(userId, request.message, signal), learningTimeoutMs).then((timed) =>
        logLearning(userId, timed, learningTimeoutMs),
      ),
    );
  }

  // The five texts the agent starts with, as it receives them: measuring them adds no model call.
  const context = contextBreakdown({
    system: strategy.systemPrompt ?? "",
    tools: toolDefinitionsText(tools),
    history: historyBlock(history, summaryText),
    memories: memoryBlock(recalled),
    message: request.message,
  });

  return {
    ...outcome,
    conversation: { id: conversationId, historyMessages: history.length },
    recalledMemories: recalled.length,
    context,
  };
}
