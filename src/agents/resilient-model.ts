import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { type Runnable, RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { ModelUnavailableError } from "../domain/errors.ts";
import { retryFailedCall } from "./model.ts";

/** Attempts per model for one call: the first try plus one retry, as in the course example. */
export const MODEL_ATTEMPTS = 2;

/** A chat model and the name the trace and `metrics.modelUsed` show for it. */
export interface NamedModel {
  model: BaseChatModel;
  name: string;
}

export interface ResilientModelOptions {
  primary: NamedModel;
  fallback?: NamedModel | undefined;
  /** Attempts per model, retries included. Tests pass 1, because `withRetry` always waits about 1 s. */
  attempts?: number;
}

/** Marks a model's runs, so the call counter can tell the fallback's from the primary's. */
function marked(runnable: Runnable, { name }: NamedModel, role: "primary" | "fallback"): Runnable {
  return runnable.withConfig({ metadata: { opspilotModel: name, opspilotModelRole: role } });
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * One chat model that retries each model, then tries the fallback once the primary is out of
 * attempts. `withRetry` and `withFallbacks` return plain runnables that lack `bindTools` and
 * `withStructuredOutput`, which the agents need. So tools and the output schema are bound on each
 * model first, and the retry and fallback wrap the bound models.
 */
export class ResilientChatModel extends BaseChatModel {
  private readonly primary: NamedModel;
  private readonly fallback: NamedModel | undefined;
  private readonly attempts: number;

  constructor({ primary, fallback, attempts = MODEL_ATTEMPTS }: ResilientModelOptions) {
    super({});
    this.primary = primary;
    this.fallback = fallback;
    this.attempts = attempts;
  }

  _llmType(): string {
    return "resilient";
  }

  /** Never used: `invoke` is overridden and goes through the wrapped models. */
  async _generate(): Promise<ChatResult> {
    throw new Error("ResilientChatModel only supports invoke, bindTools and withStructuredOutput");
  }

  // The return types stay loose: these methods hand back composed runnables, not chat models.
  override async invoke(input: any, options?: any): Promise<any> {
    return this.compose((model) => model).invoke(input, options);
  }

  override bindTools(tools: any[], kwargs?: any): any {
    return this.compose((model) => {
      if (model.bindTools === undefined) throw new Error("The wrapped chat model cannot bind tools");
      return model.bindTools(tools, kwargs);
    });
  }

  override withStructuredOutput(schema: any, config?: any): any {
    return this.compose((model) => model.withStructuredOutput(schema, config));
  }

  /**
   * `shape` binds tools or a schema on a model. The primary retries, then the fallback, which also
   * retries. Whatever the models end with becomes a `ModelUnavailableError`, except a cancellation:
   * that propagates, so a timed out request is still a 504.
   */
  private compose(shape: (model: BaseChatModel) => Runnable): Runnable {
    const retry = { stopAfterAttempt: this.attempts, onFailedAttempt: retryFailedCall };
    const primary = marked(shape(this.primary.model), this.primary, "primary").withRetry(retry);
    const composed =
      this.fallback === undefined
        ? primary
        : primary.withFallbacks([marked(shape(this.fallback.model), this.fallback, "fallback").withRetry(retry)]);
    return RunnableLambda.from(async (input: unknown, config?: RunnableConfig) => {
      try {
        return await composed.invoke(input, config);
      } catch (error) {
        if (isCancellation(error, config?.signal)) throw error;
        throw new ModelUnavailableError(error instanceof Error ? error.name : "Error", error);
      }
    });
  }
}

/** The model factory's resilient model: retries on the primary, then the fallback when one is set. */
export function createResilientModel(options: ResilientModelOptions): BaseChatModel {
  return new ResilientChatModel(options);
}
