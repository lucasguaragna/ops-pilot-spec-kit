import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent, createMiddleware, modelCallLimitMiddleware } from "langchain";
import type { ReasoningStrategy, RunResult } from "../domain/types.ts";
import { lastAnswer, messagesToTrace } from "../trace/from-messages.ts";
import { LlmCallCounter } from "./llm-counter.ts";
import { isIterationLimitError, toRunError } from "./run-outcome.ts";

const SYSTEM_PROMPT =
  "You are OpsPilot, an on-call copilot for production alerts and incidents. You have live access " +
  "to alerts and incidents only through the tools, so call them before answering. Do every action " +
  "the request asks for, such as opening or resolving incidents, in the order it asks, and only " +
  "answer once all of them are done. Use exact service names as list_alerts shows them. Never say " +
  "something was opened or resolved without a tool result that proves it. Answer briefly.";

/** Model calls allowed per turn while the agent has no tool result to ground its answer on. */
export const GROUNDING_ATTEMPTS = 3;

/** True once a tool has answered in the conversation. */
export function hasToolResult(messages: readonly BaseMessage[]): boolean {
  return messages.some((message) => ToolMessage.isInstance(message));
}

/**
 * Re-asks the model when it answers in plain text before any tool has run. Routers such as
 * openrouter/free sometimes pick a model that ignores the tools and claims it has no access.
 */
const requireToolUse = createMiddleware({
  name: "RequireToolUse",
  wrapModelCall: async (request, handler) => {
    let response = await handler(request);
    for (let attempt = 1; attempt < GROUNDING_ATTEMPTS && !hasToolResult(request.messages); attempt++) {
      if (!AIMessage.isInstance(response) || (response.tool_calls?.length ?? 0) > 0) break;
      response = await handler(request);
    }
    return response;
  },
});

export interface StrategyDependencies {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
}

export function createReactStrategy({ model, tools }: StrategyDependencies): ReasoningStrategy {
  return {
    name: "react",
    async run(input, { maxIterations, signal }): Promise<RunResult> {
      const started = Date.now();
      const counter = new LlmCallCounter();
      const agent = createAgent({
        model,
        tools,
        systemPrompt: SYSTEM_PROMPT,
        // Guardrail: one iteration is one model turn, so a looping agent stops here.
        middleware: [
          modelCallLimitMiddleware({ runLimit: maxIterations, exitBehavior: "error" }),
          requireToolUse,
        ],
      });

      // Streamed values keep the latest messages, so a failed run still has its partial trace.
      let messages: BaseMessage[] = [];
      const outcome = await (async () => {
        try {
          const stream = await agent.stream(
            { messages: [{ role: "user", content: input }] },
            // Safety net only; the middleware above is the real limit.
            { streamMode: "values", callbacks: [counter], recursionLimit: maxIterations * 4 + 10, signal },
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
