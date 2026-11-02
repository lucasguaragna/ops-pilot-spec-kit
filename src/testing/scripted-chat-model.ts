import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** One scripted turn: a reply, or an error to throw in place of a provider failure. */
export type ScriptedTurn = AIMessage | Error;

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

  override bindTools(): ScriptedChatModel {
    return new ScriptedChatModel(this.script);
  }

  async _generate(): Promise<ChatResult> {
    const { turns } = this.script;
    const call = this.script.calls;
    const turn = turns[Math.min(call, turns.length - 1)];
    this.script.calls += 1;
    if (!turn) throw new Error("ScriptedChatModel has no turns");
    if (turn instanceof Error) throw turn;
    // A fresh message per call: the graph merges messages by id, so a reused one would be replaced.
    // Real chat models return chunks, and structured output parsing requires one.
    const message = new AIMessageChunk({
      content: turn.content,
      tool_calls: turn.tool_calls?.map((toolCall) => ({ ...toolCall, id: `${toolCall.id}-${call}` })),
    });
    return { generations: [{ text: message.text, message }] };
  }
}

export function toolCallTurn(name: string, args: Record<string, unknown>, text = ""): AIMessage {
  return new AIMessage({ content: text, tool_calls: [{ id: `call-${name}`, name, args, type: "tool_call" }] });
}

export function textTurn(text: string): AIMessage {
  return new AIMessage(text);
}
