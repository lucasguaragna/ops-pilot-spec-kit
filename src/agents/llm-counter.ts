import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { addPromptTokens, promptTokensOf } from "../context/tokens.ts";
import type { TraceEvent } from "../domain/types.ts";

/** One model call that went from the primary model to the fallback. */
export interface Switch {
  from: string;
  to: string;
  /** Class name of the error that ended the primary attempts, never provider text. */
  error: string;
}

/** The `fallback` trace events for these switches, in order. The graph adds the `node`. */
export function fallbackEvents(switches: readonly Switch[]): Extract<TraceEvent, { type: "fallback" }>[] {
  return switches.map(({ from, to, error }) => ({ type: "fallback", from, to, error }));
}

/**
 * Counts every chat model call in a run, including structured output calls, and sums the input
 * tokens the provider reported for the calls that finished.
 */
export class LlmCallCounter extends BaseCallbackHandler {
  name = "llm-call-counter";
  count = 0;
  /** Null until some finished call reports usage, so "not reported" differs from 0. */
  promptTokens: number | null = null;
  /** One per model call that went to the fallback, in order. */
  switches: Switch[] = [];
  /** The model of the last finished call that the resilient model marked; null when none was. */
  modelUsed: string | null = null;

  private readonly modelOfRun = new Map<string, string>();
  private lastPrimary = "";
  private lastError = "Error";
  private inFallback = false;

  constructor() {
    super();
    // Count synchronously so metrics are final when the run returns.
    this.awaitHandlers = true;
  }

  /**
   * Counts every request, retries and the fallback included. The resilient model marks each run
   * with the model's name and role in the run metadata; a plain model has none, so it never adds a
   * switch.
   */
  override handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.count += 1;
    const model = metadata?.opspilotModel;
    if (typeof model !== "string") return;
    this.modelOfRun.set(runId, model);
    if (metadata?.opspilotModelRole === "primary") {
      this.lastPrimary = model;
      this.inFallback = false;
    } else if (metadata?.opspilotModelRole === "fallback" && !this.inFallback) {
      // The fallback's own retries start more runs, but they are still the same switch.
      this.inFallback = true;
      this.switches.push({ from: this.lastPrimary, to: model, error: this.lastError });
    }
  }

  /** Remembers the class name of the failure, which names the switch if the next run is the fallback's. */
  override handleLLMError(error: Error): void {
    this.lastError = error.name || "Error";
  }

  /** A call that fails or is aborted never reaches here, so it adds nothing. */
  override handleLLMEnd(output: LLMResult, runId: string): void {
    this.promptTokens = addPromptTokens(this.promptTokens, promptTokensOf(output));
    this.modelUsed = this.modelOfRun.get(runId) ?? this.modelUsed;
  }

  /** Returns the switches recorded so far and forgets them, so each step reports only its own. */
  takeSwitches(): Switch[] {
    return this.switches.splice(0);
  }
}
