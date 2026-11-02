import type { z } from "zod";

/**
 * Attempts per structured-output call. Routers like openrouter/free pick a model per call and
 * ignore provider preferences, and some picks answer in text instead of the forced tool call
 * (3 of 8 probes), so a few cheap retries make a miss on every attempt unlikely.
 */
export const STRUCTURED_ATTEMPTS = 5;

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
