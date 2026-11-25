import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { addPromptTokens } from "../context/tokens.ts";
import type { ReasoningStrategy, RunResult, TraceEvent } from "../domain/types.ts";
import { fallbackEvents, LlmCallCounter } from "./llm-counter.ts";
import { toRunError } from "./run-outcome.ts";
import { structured } from "./structured-output.ts";
import { carrySystemPrompt } from "./system-prompt.ts";

export const DEFAULT_MAX_REFLECTIONS = 2;
export const VERDICT_TOOL_NAME = "verdict";

const CRITIC_PROMPT =
  "You are OpsPilot's critic. Judge the answer ONLY against the tool observations you are given, " +
  "never against your own knowledge. Approve when every claim in the answer is backed by an " +
  "observation and the answer covers the whole request. Otherwise reject, say exactly what is " +
  "wrong and what to do, and pick a fix: rewrite when the observations already hold what the " +
  "request needs and only the answer misstates or omits it; rerun when an action the request " +
  "needs is missing or failed in a way another try can fix.";

const REWRITE_PROMPT =
  "You are OpsPilot. Rewrite the answer to the request so it states only what the observations " +
  "show, and fix what the reviewer pointed out. Reply with the answer only, briefly.";

export const verdictSchema = z
  .object({
    approved: z.boolean().describe("true only when every claim is backed by an observation"),
    feedback: z
      .string()
      .describe("When rejected, what to fix, specific and actionable; may be empty when approved"),
    fix: z
      .enum(["rerun", "rewrite"])
      .optional()
      .describe("Required when rejected: rerun to act again with the tools, rewrite to fix only the text"),
  })
  .refine((verdict) => verdict.approved || verdict.fix !== undefined, {
    message: "fix is required when approved is false",
    path: ["fix"],
  });
export type Verdict = z.infer<typeof verdictSchema>;

const MaxReflections = z.number().int().min(0).default(DEFAULT_MAX_REFLECTIONS);

export interface ReflectionOptions {
  model: BaseChatModel;
  maxReflections?: number;
}

type ObservationEvent = Extract<TraceEvent, { type: "observation" }>;

export function observationsOf(trace: readonly TraceEvent[]): ObservationEvent[] {
  return trace.filter((event): event is ObservationEvent => event.type === "observation");
}

function listObservations(trace: readonly TraceEvent[]): string {
  const observations = observationsOf(trace);
  return observations.length === 0
    ? "(none)"
    : observations.map((event, index) => `${index + 1}. ${event.tool}: ${event.content}`).join("\n");
}

export function toCritique({ approved, feedback, fix }: Verdict): TraceEvent {
  return approved || fix === undefined
    ? { type: "critique", approved, content: feedback }
    : { type: "critique", approved, fix, content: feedback };
}

export function criticMessages(request: string, answer: string, trace: readonly TraceEvent[]) {
  return [
    new SystemMessage(CRITIC_PROMPT),
    new HumanMessage(`Request: ${request}\nObservations:\n${listObservations(trace)}\nAnswer: ${answer}`),
  ];
}

export function rewriteMessages(request: string, answer: string, feedback: string, trace: readonly TraceEvent[]) {
  return [
    new SystemMessage(REWRITE_PROMPT),
    new HumanMessage(
      `Request: ${request}\nObservations:\n${listObservations(trace)}\n` +
        `Rejected answer: ${answer}\nReviewer feedback: ${feedback}`,
    ),
  ];
}

/** Each action paired with the first later observation of the same tool. */
function actionsWithResults(trace: readonly TraceEvent[]): string[] {
  return trace.flatMap((event, index) => {
    if (event.type !== "action") return [];
    const result = trace
      .slice(index + 1)
      .find((later): later is ObservationEvent => later.type === "observation" && later.tool === event.tool);
    return [`- ${event.tool} ${JSON.stringify(event.args)} -> ${result?.content ?? "(no result)"}`];
  });
}

/** The input for a rerun: the request, the feedback, and what earlier attempts already did. */
export function rerunInput(request: string, feedback: string, trace: readonly TraceEvent[]): string {
  const actions = actionsWithResults(trace);
  const done =
    actions.length === 0
      ? "No actions were taken yet."
      : `Actions already taken; do not repeat them, use their results:\n${actions.join("\n")}`;
  return `${request}\n\nA reviewer rejected the previous answer: ${feedback}\n${done}`;
}

/** The trace note for a critic or rewrite failure, which keeps the last answer. */
export function skippedReflection(error: Error): TraceEvent {
  return { type: "thought", content: `Reflection skipped, answer kept: ${error.message}` };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Decides what follows a critique: stop, or regenerate with the verdict's fix. */
export function nextStep(
  verdict: Verdict,
  regenerations: number,
  maxReflections: number,
): "stop" | "rerun" | "rewrite" {
  if (verdict.approved || regenerations >= maxReflections) return "stop";
  // The schema requires fix on a rejection; rerun is the safe default if it is ever missing.
  return verdict.fix ?? "rerun";
}

export function withReflection(strategy: ReasoningStrategy, options: ReflectionOptions): ReasoningStrategy {
  const maxReflections = MaxReflections.parse(options.maxReflections);
  const { model } = options;
  const critic = model.withStructuredOutput(verdictSchema, {
    name: VERDICT_TOOL_NAME,
    method: "functionCalling",
    includeRaw: true,
  });

  return {
    name: `reflect:${strategy.name}`,
    ...carrySystemPrompt(strategy),
    async run(input, runOptions): Promise<RunResult> {
      const started = Date.now();
      const counter = new LlmCallCounter();
      const config = { callbacks: [counter], signal: runOptions.signal };
      let trace: TraceEvent[] = [];
      let baseCalls = 0;
      let basePromptTokens: number | null = null;
      // The model of the newest finished call: the inner strategy's, then the critic's or the rewrite's.
      let modelUsed: string | null = null;
      const metrics = () => ({
        llmCalls: baseCalls + counter.count,
        latencyMs: Date.now() - started,
        promptTokens: addPromptTokens(basePromptTokens, counter.promptTokens),
        modelUsed,
      });

      try {
        let attempt = await strategy.run(input, runOptions);
        for (let regenerations = 0; ; regenerations++) {
          trace = [...trace, ...attempt.trace];
          baseCalls += attempt.metrics.llmCalls;
          basePromptTokens = addPromptTokens(basePromptTokens, attempt.metrics.promptTokens);
          modelUsed = attempt.metrics.modelUsed ?? modelUsed;
          if (attempt.stopReason !== "completed") return { ...attempt, trace, metrics: metrics() };

          const { answer } = attempt;
          // The critic and the rewrite only audit a finished answer, so their failure keeps it.
          const keepAnswer = (error: Error): RunResult => ({
            stopReason: "completed",
            answer,
            trace: [...trace, ...fallbackEvents(counter.takeSwitches()), skippedReflection(error)],
            metrics: metrics(),
          });

          runOptions.signal?.throwIfAborted();
          const verdict = await structured("critic", verdictSchema, () =>
            critic.invoke(criticMessages(input, answer, trace), config),
          ).catch(asError);
          modelUsed = counter.modelUsed ?? modelUsed;
          if (verdict instanceof Error) {
            // An abort is not a critic failure: it must end the run instead of keeping the answer.
            runOptions.signal?.throwIfAborted();
            return keepAnswer(verdict);
          }
          trace = [...trace, ...fallbackEvents(counter.takeSwitches()), toCritique(verdict)];

          const step = nextStep(verdict, regenerations, maxReflections);
          if (step === "stop") return { stopReason: "completed", answer, trace, metrics: metrics() };
          if (step === "rerun") {
            runOptions.signal?.throwIfAborted();
            attempt = await strategy.run(rerunInput(input, verdict.feedback, trace), runOptions);
          } else {
            const reply = await model
              .invoke(rewriteMessages(input, answer, verdict.feedback, trace), config)
              .catch(asError);
            modelUsed = counter.modelUsed ?? modelUsed;
            if (reply instanceof Error) {
              runOptions.signal?.throwIfAborted();
              return keepAnswer(reply);
            }
            // The rewrite call is counted by the counter, so the attempt adds no calls or tokens of its own.
            attempt = {
              stopReason: "completed",
              answer: reply.text,
              trace: [...fallbackEvents(counter.takeSwitches()), { type: "answer", content: reply.text }],
              metrics: { llmCalls: 0, latencyMs: 0, promptTokens: null, modelUsed: null },
            };
          }
        }
      } catch (error) {
        return {
          stopReason: "error",
          answer: null,
          error: toRunError(error),
          trace: [...trace, ...fallbackEvents(counter.takeSwitches())],
          metrics: metrics(),
        };
      }
    },
  };
}
