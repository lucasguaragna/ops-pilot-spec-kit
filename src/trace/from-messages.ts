import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { TraceEvent } from "../domain/types.ts";

/**
 * Maps an agent conversation to trace events. AI text next to tool calls is a thought; AI text
 * with no tool calls is the answer. User and system messages are left out.
 */
export function messagesToTrace(messages: readonly BaseMessage[]): TraceEvent[] {
  const toolNames = new Map<string, string>();
  return messages.flatMap((message): TraceEvent[] => {
    if (AIMessage.isInstance(message)) {
      const calls = message.tool_calls ?? [];
      const text = message.text.trim();
      if (calls.length === 0) return [{ type: "answer", content: text }];
      calls.forEach((call) => call.id && toolNames.set(call.id, call.name));
      const thought: TraceEvent[] = text ? [{ type: "thought", content: text }] : [];
      return [...thought, ...calls.map((call): TraceEvent => ({ type: "action", tool: call.name, args: call.args }))];
    }
    if (ToolMessage.isInstance(message)) {
      const tool = message.name ?? toolNames.get(message.tool_call_id) ?? "unknown";
      return [{ type: "observation", tool, content: message.text }];
    }
    return [];
  });
}

export function lastAnswer(trace: readonly TraceEvent[]): string {
  const answer = trace.findLast((event) => event.type === "answer");
  return answer?.type === "answer" ? answer.content : "";
}
