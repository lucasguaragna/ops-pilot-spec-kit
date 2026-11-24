import type { Memory } from "../domain/schemas.ts";
import type { ReasoningStrategy } from "../domain/types.ts";

/**
 * Pure: puts the recalled facts ahead of the input. Each fact carries its id, so the agent can name
 * it to forget_fact. No facts returns the input unchanged, so a request without memories behaves
 * exactly as before.
 */
export function composeMemoryInput(memories: readonly Pick<Memory, "id" | "fact">[], input: string): string {
  if (memories.length === 0) return input;
  const facts = memories.map(({ id, fact }) => `- [memory ${id}] ${fact}`).join("\n");
  return `Facts remembered about this engineer (best match first; they may be out of date):\n${facts}\n\n${input}`;
}

/**
 * Wraps any strategy so it sees the recalled facts, the same way `withHistory` does. Wrap it inside
 * `withHistory`, so the facts come first, then the conversation, then the current request.
 */
export function withMemories(
  strategy: ReasoningStrategy,
  memories: readonly Pick<Memory, "id" | "fact">[],
): ReasoningStrategy {
  return {
    name: strategy.name,
    run: (input, options) => strategy.run(composeMemoryInput(memories, input), options),
  };
}
