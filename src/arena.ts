import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createModel } from "./agents/model.ts";
import { createPlanExecuteStrategy } from "./agents/plan-and-execute.ts";
import { createReactStrategy, type StrategyDependencies } from "./agents/react.ts";
import { withReflection } from "./agents/reflection.ts";
import { toRunError } from "./agents/run-outcome.ts";
import { createTools } from "./agents/tools.ts";
import type { ReasoningStrategy } from "./domain/types.ts";
import { createStore } from "./store/in-memory-store.ts";
import { createJsonFileBackend } from "./store/json-file-store.ts";
import { formatResult } from "./trace/format.ts";

export const DEFAULT_INPUT =
  "Check which alerts are firing and open an incident for the most severe one.";

const strategyFactories = {
  react: createReactStrategy,
  "plan-execute": createPlanExecuteStrategy,
  "reflect:react": (dependencies) =>
    withReflection(createReactStrategy(dependencies), { model: dependencies.model }),
  "reflect:plan-execute": (dependencies) =>
    withReflection(createPlanExecuteStrategy(dependencies), { model: dependencies.model }),
} satisfies Record<string, (dependencies: StrategyDependencies) => ReasoningStrategy>;

const strategyNames = Object.keys(strategyFactories) as [keyof typeof strategyFactories];
const StrategyName = z.enum(strategyNames, {
  error: (issue) => `Unknown strategy "${String(issue.input)}". Known: ${strategyNames.join(", ")}`,
});

const ArenaOptions = z.object({
  input: z.string().trim().min(1, "--input must not be empty"),
  strategies: z.array(StrategyName).min(1, "--strategies needs at least one name"),
  maxIterations: z.coerce.number().int().positive("--max-iterations must be a positive integer"),
});
export type ArenaOptions = z.infer<typeof ArenaOptions>;

export type ParsedArgs = { ok: true; options: ArenaOptions } | { ok: false; message: string };

export function parseArenaArgs(argv: readonly string[]): ParsedArgs {
  let values: { input?: string; strategies?: string; "max-iterations"?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        input: { type: "string" },
        strategies: { type: "string" },
        "max-iterations": { type: "string" },
      },
    }));
  } catch (error) {
    return { ok: false, message: toRunError(error).message };
  }
  if (positionals.length > 0 && values.input !== undefined) {
    return { ok: false, message: "Pass the input either as text or with --input, not both" };
  }
  // Unquoted words arrive as separate positionals, so they are joined back into one request.
  const positionalInput = positionals.length > 0 ? positionals.join(" ") : undefined;

  const names = (values.strategies ?? "react,plan-execute")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const parsed = ArenaOptions.safeParse({
    input: values.input ?? positionalInput ?? DEFAULT_INPUT,
    strategies: [...new Set(names)],
    maxIterations: values["max-iterations"] ?? "10",
  });
  if (parsed.success) return { ok: true, options: parsed.data };
  return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/** Runs each strategy against the JSON database and returns the exit code. */
export async function runArena({ input, strategies, maxIterations }: ArenaOptions): Promise<number> {
  let allCompleted = true;
  for (const name of strategies) {
    try {
      const strategy = strategyFactories[name]({
        model: createModel(),
        tools: [...createTools(createStore(createJsonFileBackend()))],
      });
      const result = await strategy.run(input, { maxIterations });
      console.log(formatResult(strategy.name, result), "\n");
      if (result.stopReason !== "completed") allCompleted = false;
    } catch (error) {
      const { name: errorName, message } = toRunError(error);
      console.error(`${name}: ${errorName}: ${message}`);
      allCompleted = false;
    }
  }
  return allCompleted ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArenaArgs(argv);
  if (!parsed.ok) {
    console.error(`Invalid arguments: ${parsed.message}`);
    return 2;
  }
  return runArena(parsed.options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
