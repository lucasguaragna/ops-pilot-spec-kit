import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { addPromptTokens, promptTokensOf } from "../context/tokens.ts";

/**
 * Counts every chat model call in a run, including structured output calls, and sums the input
 * tokens the provider reported for the calls that finished.
 */
export class LlmCallCounter extends BaseCallbackHandler {
  name = "llm-call-counter";
  count = 0;
  /** Null until some finished call reports usage, so "not reported" differs from 0. */
  promptTokens: number | null = null;

  constructor() {
    super();
    // Count synchronously so metrics are final when the run returns.
    this.awaitHandlers = true;
  }

  override handleChatModelStart(): void {
    this.count += 1;
  }

  /** A call that fails or is aborted never reaches here, so it adds nothing. */
  override handleLLMEnd(output: LLMResult): void {
    this.promptTokens = addPromptTokens(this.promptTokens, promptTokensOf(output));
  }
}
