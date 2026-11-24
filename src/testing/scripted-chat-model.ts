import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** Marks a turn that never answers: the call stays pending until its signal aborts. */
const HANG = Symbol("hang");

/**
 * One scripted turn: a reply, an error to throw in place of a provider failure, or a hang that
 * stands in for a provider that never answers.
 */
export type ScriptedTurn = AIMessage | Error | typeof HANG;

interface Script {
  turns: readonly ScriptedTurn[];
  calls: number;
}

/**
 * Test-only chat model that replays scripted turns, repeating the last one when the script runs
 * out. Bound copies share the script, so `calls` counts every model call in a run.
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly script: Script;

  constructor(turns: readonly ScriptedTurn[] | Script) {
    super({});
    this.script = Array.isArray(turns) ? { turns, calls: 0 } : (turns as Script);
  }

  get calls(): number {
    return this.script.calls;
  }

  _llmType(): string {
    return "scripted";
  }

  /** Bound copies keep the script and the callbacks, so a test's handler also sees structured calls. */
  override bindTools(): ScriptedChatModel {
    const bound = new ScriptedChatModel(this.script);
    bound.callbacks = this.callbacks;
    return bound;
  }

  async _generate(_messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const { turns } = this.script;
    const call = this.script.calls;
    const turn = turns[Math.min(call, turns.length - 1)];
    this.script.calls += 1;
    if (!turn) throw new Error("ScriptedChatModel has no turns");
    if (turn instanceof Error) throw turn;
    if (turn === HANG) return hang(options.signal);
    // A fresh message per call: the graph merges messages by id, so a reused one would be replaced.
    // Real chat models return chunks, and structured output parsing requires one.
    const message = new AIMessageChunk({
      content: turn.content,
      tool_calls: turn.tool_calls?.map((toolCall) => ({ ...toolCall, id: `${toolCall.id}-${call}` })),
    });
    return { generations: [{ text: message.text, message }] };
  }
}

/** Pending until the signal aborts, then rejects with its reason; never resolves. */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A turn whose call stays pending until the call's signal aborts, like a hung provider. */
export function hangingTurn(): ScriptedTurn {
  return HANG;
}

export function toolCallTurn(name: string, args: Record<string, unknown>, text = ""): AIMessage {
  return new AIMessage({ content: text, tool_calls: [{ id: `call-${name}`, name, args, type: "tool_call" }] });
}

export function textTurn(text: string): AIMessage {
  return new AIMessage(text);
}
