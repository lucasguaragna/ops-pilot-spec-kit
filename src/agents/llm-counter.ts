import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/** Counts every chat model call in a run, including structured output calls. */
export class LlmCallCounter extends BaseCallbackHandler {
  name = "llm-call-counter";
  count = 0;

  constructor() {
    super();
    // Count synchronously so metrics are final when the run returns.
    this.awaitHandlers = true;
  }

  override handleChatModelStart(): void {
    this.count += 1;
  }
}
