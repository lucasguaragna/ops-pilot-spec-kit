import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent, modelCallLimitMiddleware } from "langchain";
import type { ReasoningStrategy, RunResult } from "../domain/types.ts";
import { lastAnswer, messagesToTrace } from "../trace/from-messages.ts";
import { LlmCallCounter } from "./llm-counter.ts";
import { isIterationLimitError, toRunError } from "./run-outcome.ts";

const SYSTEM_PROMPT =
  "You are OpsPilot, an on-call copilot for production alerts and incidents. Use the tools to " +
  "check facts before answering, and answer briefly.";

export interface StrategyDependencies {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
}

export function createReactStrategy({ model, tools }: StrategyDependencies): ReasoningStrategy {
  return {
    name: "react",
    async run(input, { maxIterations }): Promise<RunResult> {
      const started = Date.now();
      const counter = new LlmCallCounter();
      const agent = createAgent({
        model,
        tools,
        systemPrompt: SYSTEM_PROMPT,
        // Guardrail: one iteration is one model turn, so a looping agent stops here.
        middleware: [modelCallLimitMiddleware({ runLimit: maxIterations, exitBehavior: "error" })],
      });

      // Streamed values keep the latest messages, so a failed run still has its partial trace.
      let messages: BaseMessage[] = [];
      const outcome = await (async () => {
        try {
          const stream = await agent.stream(
            { messages: [{ role: "user", content: input }] },
            // Safety net only; the middleware above is the real limit.
            { streamMode: "values", callbacks: [counter], recursionLimit: maxIterations * 4 + 10 },
          );
          for await (const state of stream) messages = state.messages;
          return { stopReason: "completed" } as const;
        } catch (error) {
          return isIterationLimitError(error)
            ? ({ stopReason: "iteration_limit" } as const)
            : ({ stopReason: "error", error: toRunError(error) } as const);
        }
      })();

      const trace = messagesToTrace(messages);
      const metrics = { llmCalls: counter.count, latencyMs: Date.now() - started };
      if (outcome.stopReason === "completed") {
        return { stopReason: "completed", answer: lastAnswer(trace), trace, metrics };
      }
      return { ...outcome, answer: null, trace, metrics };
    },
  };
}
