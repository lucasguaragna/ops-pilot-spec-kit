import type { AIMessage } from "@langchain/core/messages";
import { LEARNING_TOOL_NAME, type LearningVerdict } from "../agents/learning-reflector.ts";
import { toolCallTurn } from "./scripted-chat-model.ts";

/** A scripted model turn that answers the learning step with this verdict. */
export function learningTurn(verdict: LearningVerdict): AIMessage {
  return toolCallTurn(LEARNING_TOOL_NAME, verdict);
}

/** The learning step's answer for a message with nothing lasting in it. */
export const NO_LEARNING = learningTurn({ hasLearning: false, fact: "" });
