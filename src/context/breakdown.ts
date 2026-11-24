import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { estimateTokens } from "./tokens.ts";

/** The five texts an agent starts a run with, exactly as it receives them. */
export interface ContextTexts {
  system: string;
  tools: string;
  history: string;
  memories: string;
  message: string;
}

/** The estimated tokens of each source, and their sum. */
export interface ContextBreakdown {
  system: number;
  tools: number;
  history: number;
  memories: number;
  message: number;
  total: number;
}

/**
 * Each source estimated with `estimateTokens`. The total is the sum of the five estimates, not the
 * estimate of their concatenation, so the parts always add up.
 */
export function contextBreakdown(texts: ContextTexts): ContextBreakdown {
  const system = estimateTokens(texts.system);
  const tools = estimateTokens(texts.tools);
  const history = estimateTokens(texts.history);
  const memories = estimateTokens(texts.memories);
  const message = estimateTokens(texts.message);
  return { system, tools, history, memories, message, total: system + tools + history + memories + message };
}

/**
 * The tool definitions as the provider receives them (name, description, and the JSON Schema of
 * the arguments) in one string. "[]" when there are none.
 */
export function toolDefinitionsText(tools: readonly StructuredToolInterface[]): string {
  return JSON.stringify(tools.map((tool) => convertToOpenAITool(tool)));
}
