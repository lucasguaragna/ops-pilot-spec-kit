import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { LlmCallCounter } from "../agents/llm-counter.ts";
import type { RouteDecision } from "../domain/types.ts";
import { decideRoute, ROUTER_PROMPT, routeAnswerSchema } from "./routing.ts";

export const ROUTE_TOOL_NAME = "route";

export interface RouterResult {
  decision: RouteDecision;
  /** Model calls the router made (1, or 0 if it failed before calling). */
  llmCalls: number;
  promptTokens: number | null;
}

export interface Router {
  /**
   * One structured-output call, no retry. A thrown error or an invalid answer becomes a `react`
   * fallback decision. Rejects only when the signal is aborted, so a timeout stops the run.
   */
  route(input: string, config: { signal?: AbortSignal }): Promise<RouterResult>;
}

export function createRouter({ model }: { model: BaseChatModel }): Router {
  const structuredModel = model.withStructuredOutput(routeAnswerSchema, {
    name: ROUTE_TOOL_NAME,
    method: "functionCalling",
    includeRaw: true,
  });
  return {
    async route(input, { signal }) {
      const counter = new LlmCallCounter();
      try {
        signal?.throwIfAborted();
        const { parsed } = await structuredModel.invoke(
          [new SystemMessage(ROUTER_PROMPT), new HumanMessage(input)],
          { callbacks: [counter], signal },
        );
        return result(decideRoute({ kind: "answered", parsed }), counter);
      } catch (error) {
        // An abort is not a router failure: it must end the run instead of starting a fallback.
        signal?.throwIfAborted();
        return result(decideRoute({ kind: "thrown", error }), counter);
      }
    },
  };
}

const result = (decision: RouteDecision, counter: LlmCallCounter): RouterResult => ({
  decision,
  llmCalls: counter.count,
  promptTokens: counter.promptTokens,
});
