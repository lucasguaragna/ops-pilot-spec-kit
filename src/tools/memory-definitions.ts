import { ForgetFactInput, ForgetPreferenceInput, RememberFactInput } from "../domain/schemas.ts";
import type { MemoryStore } from "../memory/memory-store.ts";

/**
 * The memory tools, in the same shape as `definitions.ts`. They are kept out of `TOOL_DEFINITIONS`,
 * so the MCP server does not expose them, and every `run` takes the user id from the request, never
 * from the model.
 */

export const rememberFactDefinition = {
  name: "remember_fact",
  description:
    "Save a lasting fact about the engineer or their systems, for later conversations. Use when " +
    "the engineer states something that will still be true later (who owns a service, a " +
    "preference, a quirk of their setup), not for questions or for the state of a live alert. One " +
    "fact per call, in one short sentence. Returns { id, fact, created }; created false means a " +
    "nearly identical fact was already saved and nothing new was stored.",
  schema: RememberFactInput,
  run: async (memories: MemoryStore, userId: string, { fact }: RememberFactInput) => {
    const { memory, created } = await memories.remember(userId, fact);
    return { id: memory.id, fact: memory.fact, created };
  },
} as const;

export const forgetFactDefinition = {
  name: "forget_fact",
  description:
    "Forget a saved fact. Use when the engineer says a fact is wrong or no longer true. The id is " +
    "the N in [memory N] from the remembered facts at the top of the request. Returns { id, " +
    "forgotten: true }. Returns 'Error: ...' when there is no such fact.",
  schema: ForgetFactInput,
  run: (memories: MemoryStore, userId: string, { id }: ForgetFactInput) => {
    memories.forget(userId, id);
    return { id, forgotten: true };
  },
} as const;

export const forgetPreferenceDefinition = {
  name: "forget_preference",
  description:
    "Forget a saved fact by describing it, when the engineer asks you to forget something and you " +
    "do not have its [memory N] id. Give a short description of the fact, for example 'prefers " +
    "bullet lists'. Only the single closest saved fact is removed, and only if it matches closely. " +
    "Returns { id, fact, forgotten: true } for the removed fact, or { forgotten: false } when no " +
    "saved fact matches.",
  schema: ForgetPreferenceInput,
  run: async (memories: MemoryStore, userId: string, { description }: ForgetPreferenceInput) => {
    const memory = await memories.forgetClosest(userId, description);
    return memory ? { id: memory.id, fact: memory.fact, forgotten: true } : { forgotten: false };
  },
} as const;
