import { tool } from "@langchain/core/tools";
import type { MemoryStore } from "../memory/memory-store.ts";
import { runToolText, runToolTextAsync } from "../tools/definitions.ts";
import { forgetFactDefinition, rememberFactDefinition } from "../tools/memory-definitions.ts";

/**
 * The memory tools for one request. `userId` is captured here and is not in any schema, so the
 * model can never act for another user (FR-017). Building them is pure: nothing is read or written
 * until the model calls one.
 */
export function createMemoryTools(memories: MemoryStore, userId: string) {
  const rememberFact = tool(
    async (input) => (await runToolTextAsync(() => rememberFactDefinition.run(memories, userId, input))).text,
    {
      name: rememberFactDefinition.name,
      description: rememberFactDefinition.description,
      schema: rememberFactDefinition.schema,
    },
  );

  const forgetFact = tool(
    async (input) => runToolText(() => forgetFactDefinition.run(memories, userId, input)).text,
    {
      name: forgetFactDefinition.name,
      description: forgetFactDefinition.description,
      schema: forgetFactDefinition.schema,
    },
  );

  return [rememberFact, forgetFact] as const;
}
