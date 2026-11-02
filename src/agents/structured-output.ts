import type { z } from "zod";

/** Attempts per structured-output call; some OpenRouter models skip the tool call now and then. */
export const STRUCTURED_ATTEMPTS = 2;

/**
 * Calls a model bound with `withStructuredOutput(..., { includeRaw: true })`, retrying when the
 * parsed output is missing or invalid, then fails with a clear error.
 */
export async function structured<T>(
  role: string,
  schema: z.ZodType<T>,
  call: () => Promise<{ parsed: unknown }>,
): Promise<T> {
  for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt++) {
    const { parsed } = await call();
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  }
  throw new Error(`The ${role} returned no structured output after ${STRUCTURED_ATTEMPTS} attempts`);
}
