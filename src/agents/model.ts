import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { ConfigurationError } from "../domain/errors.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const ModelSettings = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  OPENROUTER_MODEL: z.string().trim().min(1),
});

/** The single model factory. Reads settings when called, so importing it never fails. */
export function createModel(env: Record<string, string | undefined> = process.env): ChatOpenAI {
  const settings = ModelSettings.safeParse(env);
  if (!settings.success) {
    throw new ConfigurationError(settings.error.issues.map((issue) => issue.path.join(".")));
  }
  return new ChatOpenAI({
    model: settings.data.OPENROUTER_MODEL,
    apiKey: settings.data.OPENROUTER_API_KEY,
    configuration: { baseURL: OPENROUTER_BASE_URL },
    temperature: 0,
  });
}
