import { historyBlock, MAX_VERBATIM, planHistory } from "../agents/history.ts";
import { cleanSummary, createHistorySummarizer, renderSummary } from "../agents/history-summarizer.ts";
import { LlmCallCounter } from "../agents/llm-counter.ts";
import { createLearningReflector, type LearningOutcome } from "../agents/learning-reflector.ts";
import { createRouteStrategy } from "../agents/index.ts";
import { memoryBlock } from "../agents/memories.ts";
import { createMemoryTools } from "../agents/memory-tools.ts";
import { contextBreakdown, toolDefinitionsText } from "../context/breakdown.ts";
import type { ConversationSummary, NewMessage, RecalledMemory } from "../domain/schemas.ts";
import type { ReasoningStrategy, Route } from "../domain/types.ts";
import { runProductionGraph, type ProductionGraphResult } from "../graph/production-graph.ts";
import { requestedRoute } from "../graph/routing.ts";
import type { StrategyDependencies } from "../agents/react.ts";
import {
  learningLogLine,
  messagesToSave,
  shouldLearn,
  summaryLogLine,
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

/** Runs the graph under the timeout and reports what happened to the run. */
async function runGraphTimed(
  settings: ResolvedSettings,
  run: (signal: AbortSignal) => Promise<ProductionGraphResult>,
): Promise<{ outcome: RunOutcome; graph?: ProductionGraphResult }> {
  const timed = await runWithTimeout(run, settings.timeoutMs);
  switch (timed.kind) {
    case "done":
      return { outcome: { kind: "result", result: timed.value.result }, graph: timed.value };
    case "thrown":
      return { outcome: { kind: "thrown", error: timed.error } };
    case "timeout":
      return { outcome: { kind: "timeout", timeoutMs: settings.timeoutMs } };
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
  const spent = {
    llmCalls: counter.count,
    promptTokens: counter.promptTokens,
    switches: counter.switches,
    modelUsed: counter.modelUsed,
  };
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
 * Checks a forced route, loads the history, recalls the user's facts, starts the conversation if
 * needed, runs the production graph under the timeout, saves a completed exchange, and reports what
 * happened.
 *
 * The graph is `context -> router -> react | plan-execute | reflect -> response`. The context node
 * gives the agent the user's facts, then the conversation summary, then the messages the summary does
 * not cover (8 to 14, word for word), then the request. It summarizes only on a batch boundary (see
 * `planHistory`), under its own 30 s cap, and never fails the request: if it fails, the agent gets the
 * previous summary and the newest 14 uncovered messages. That time counts toward the request timeout.
 * The router picks the strategy unless the caller forced one, and a router failure falls back to react.
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
  const override = requestedRoute(request);
  const { conversations, memories } = settings;
  const { userId } = request;
  const dependencies = settings.createDependencies();
  // The memory tools exist only for a known user, so the agent can never save a fact for nobody.
  const tools =
    userId === undefined ? dependencies.tools : [...dependencies.tools, ...createMemoryTools(memories, userId)];
  // Only the chosen route's strategy is built, once, so a request pays for one critic at most.
  const strategies = new Map<Route, ReasoningStrategy>();
  const strategyFor = (route: Route): ReasoningStrategy => {
    let strategy = strategies.get(route);
    if (strategy === undefined) {
      strategy = createRouteStrategy(settings.registry, route, { ...dependencies, tools });
      strategies.set(route, strategy);
    }
    return strategy;
  };
  // A forced route is checked first, so an unknown name reads and writes nothing (422).
  if (override !== undefined) strategyFor(override);

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
  const conversationId = request.conversationId ?? conversations.create().id;

  // Due only for an existing conversation, because it needs older messages. It runs in the graph's
  // context node, after recall (so a failed recall wastes no model call) and before the agent reads.
  const summarizeStep = async (): Promise<SummarizationStep> => {
    const step: SummarizationStep =
      request.conversationId !== undefined && plan.toSummarize.length > 0
        ? await summarize(settings, dependencies.model, request.conversationId, previous, plan.toSummarize)
        : { kind: "not_due" };
    const logLine = summaryLogLine(request.conversationId ?? "", step, settings.summaryTimeoutMs);
    if (logLine) console[logLine.stream](logLine.line);
    return step;
  };
  // After a failed or skipped summarization the previous summary stands, and the uncovered messages
  // are capped so a provider outage cannot grow the context.
  const fallbackHistory = plan.toSummarize.length > 0 ? uncovered.slice(-MAX_VERBATIM) : plan.verbatim;
  const previousSummary = previous === undefined ? "" : renderSummary(previous.summary);

  const { outcome, graph } = await runGraphTimed(settings, (signal) =>
    runProductionGraph(
      {
        router: settings.createRouter(dependencies.model),
        strategyFor,
        summarize: summarizeStep,
        maxIterations: settings.maxIterations,
      },
      { message: request.message, override, recalled, verbatim: plan.verbatim, fallbackHistory, previousSummary },
      { signal },
    ),
  );
  // A run that threw or timed out never reached the context node's result, so the fallback stands.
  const history = graph?.history ?? fallbackHistory;
  const summaryText = graph?.summaryText ?? previousSummary;

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
    system: strategyFor(graph?.decision.route ?? override ?? "react").systemPrompt ?? "",
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
