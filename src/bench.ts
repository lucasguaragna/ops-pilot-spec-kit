import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createModel } from "./agents/model.ts";
import { createPlanExecuteStrategy } from "./agents/plan-and-execute.ts";
import { createReactStrategy, type StrategyDependencies } from "./agents/react.ts";
import { toRunError } from "./agents/run-outcome.ts";
import { createTools } from "./agents/tools.ts";
import type { Alert } from "./domain/schemas.ts";
import type { ReasoningStrategy, RunResult } from "./domain/types.ts";
import { createInitialState, createStore, listAlerts, type StoreState } from "./store/in-memory-store.ts";

const MAX_ITERATIONS = 10;

/** Whether a run got the scenario right, and why not when it did not. */
export interface Check {
  ok: boolean;
  reason: string;
}

export interface Scenario {
  id: "C1" | "C2" | "C3";
  kind: string;
  input: string;
  /** Judges the store state after the run, plus the answer where the request asks for a number. */
  check(state: StoreState, answer: string): Check;
}

const COUNT_WORDS: Record<number, readonly string[]> = {
  0: ["zero", "nenhum", "nenhuma", "none", "no"],
  1: ["um", "uma", "one", "único", "única"],
  2: ["dois", "duas", "two"],
  3: ["três", "tres", "three"],
  4: ["quatro", "four"],
  5: ["cinco", "five"],
};

/** True when the answer states the count as a number or a word. A loose check, by design. */
export function mentionsCount(answer: string, count: number): boolean {
  const words = [String(count), ...(COUNT_WORDS[count] ?? [])];
  return words.some((word) => new RegExp(`(^|[^\\p{L}\\p{N}-])${word}($|[^\\p{L}\\p{N}-])`, "iu").test(answer));
}

const pass: Check = { ok: true, reason: "" };
const fail = (reason: string): Check => ({ ok: false, reason });

/** The firing alert with the earliest firedAt. */
export function oldestFiring(state: StoreState): Alert | undefined {
  return listAlerts(state, "firing").reduce<Alert | undefined>(
    (oldest, alert) => (oldest === undefined || alert.firedAt < oldest.firedAt ? alert : oldest),
    undefined,
  );
}

export function checkCriticalCount(state: StoreState, answer: string): Check {
  const expected = listAlerts(createInitialState(), "firing").filter((alert) => alert.severity === "critical").length;
  if (state.incidents.length > 0) return fail(`opened ${state.incidents.length} incident(s) on a read-only request`);
  return mentionsCount(answer, expected) ? pass : fail(`answer does not state ${expected}`);
}

export function checkThreeIncidents(state: StoreState): Check {
  const expected = [
    { service: "checkout-api", status: "resolved" },
    { service: "payments-worker", status: "open" },
    { service: "catalog-api", status: "open" },
  ];
  const actual = state.incidents.map(({ service, status }) => ({ service, status }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail(`incidents are ${actual.map((incident) => `${incident.service}:${incident.status}`).join(", ") || "none"}`);
  }
  const notSev2 = state.incidents.filter((incident) => incident.severity !== "high");
  return notSev2.length === 0
    ? pass
    : fail(`severity is not sev2 (high) for ${notSev2.map((incident) => incident.id).join(", ")}`);
}

export function checkOldestIncident(state: StoreState, answer: string): Check {
  const initial = createInitialState();
  const oldest = oldestFiring(initial);
  if (!oldest) return fail("the seed has no firing alert");
  const [incident, ...extra] = state.incidents;
  if (!incident || extra.length > 0) return fail(`expected 1 incident, found ${state.incidents.length}`);
  if (incident.service !== oldest.service) return fail(`incident for ${incident.service}, oldest is ${oldest.service}`);
  if (incident.status !== "open") return fail(`incident ${incident.id} is ${incident.status}`);
  // "Left" means firing alerts that still have no incident.
  const left = listAlerts(initial, "firing").filter((alert) => alert.service !== incident.service).length;
  return mentionsCount(answer, left) ? pass : fail(`answer does not state ${left} left`);
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "C1",
    kind: "direto",
    input: "quantos alertas críticos estão disparando?",
    check: checkCriticalCount,
  },
  {
    id: "C2",
    kind: "estruturado",
    input:
      "abra três incidentes sev2 para checkout, payment e catalog, nessa mesma ordem e resolva o primeiro.",
    check: checkThreeIncidents,
  },
  {
    id: "C3",
    kind: "dinâmico",
    input: "dos alertas disparando, abra um incidente para o mais antigo e diga quantos sobraram",
    check: checkOldestIncident,
  },
];

const ScenarioId = z.enum(["C1", "C2", "C3"], {
  error: (issue) => `Unknown scenario "${String(issue.input)}". Known: C1, C2, C3`,
});

const BenchOptions = z.object({
  scenarios: z.array(ScenarioId).min(1, "--scenario needs at least one id"),
  replanner: z.boolean(),
});
export type BenchOptions = z.infer<typeof BenchOptions>;

export type ParsedBenchArgs = { ok: true; options: BenchOptions } | { ok: false; message: string };

export function parseBenchArgs(argv: readonly string[]): ParsedBenchArgs {
  let values: { scenario?: string; "no-replanner"?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { scenario: { type: "string" }, "no-replanner": { type: "boolean" } },
    }));
  } catch (error) {
    return { ok: false, message: toRunError(error).message };
  }
  const ids = (values.scenario ?? "C1,C2,C3")
    .split(",")
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean);
  const parsed = BenchOptions.safeParse({ scenarios: [...new Set(ids)], replanner: !values["no-replanner"] });
  if (parsed.success) return { ok: true, options: parsed.data };
  return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

export interface BenchRow {
  scenario: string;
  strategy: string;
  check: Check;
  llmCalls: number;
  latencyMs: number;
}

/** A run that did not complete is wrong whatever the state, since the request was not finished. */
export function judge(scenario: Scenario, state: StoreState, result: RunResult): Check {
  if (result.stopReason === "error") return fail(`error: ${result.error.message}`);
  if (result.stopReason !== "completed") return fail(result.stopReason);
  return scenario.check(state, result.answer);
}

const HEADERS = ["cenário", "estratégia", "acerto", "llmCalls", "latencyMs"] as const;

export function formatTable(rows: readonly BenchRow[]): string {
  const cells = rows.map((row) => [
    row.scenario,
    row.strategy,
    row.check.ok ? "sim" : "não",
    String(row.llmCalls),
    String(row.latencyMs),
  ]);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...cells.map((line) => line[column]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    `| ${values.map((value, column) => value.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const failures = rows
    .filter((row) => !row.check.ok)
    .map((row) => `- ${row.scenario} ${row.strategy}: ${row.check.reason}`);
  return [
    line(HEADERS),
    line(widths.map((width) => "-".repeat(width))),
    ...cells.map(line),
    ...(failures.length > 0 ? ["", "Falhas:", ...failures] : []),
  ].join("\n");
}

function strategiesFor({ replanner }: BenchOptions): ((dependencies: StrategyDependencies) => ReasoningStrategy)[] {
  return [createReactStrategy, (dependencies) => createPlanExecuteStrategy(dependencies, { replanner })];
}

export async function runBench(options: BenchOptions): Promise<number> {
  const rows: BenchRow[] = [];
  for (const scenario of SCENARIOS.filter((item) => options.scenarios.includes(item.id))) {
    for (const create of strategiesFor(options)) {
      // A fresh in-memory store per run, so every run starts from the seed and data/db.json is untouched.
      const store = createStore();
      const strategy = create({ model: createModel(), tools: [...createTools(store)] });
      console.error(`${scenario.id} ${strategy.name}...`);
      const result = await strategy.run(scenario.input, { maxIterations: MAX_ITERATIONS });
      rows.push({
        scenario: `${scenario.id} ${scenario.kind}`,
        strategy: strategy.name,
        check: judge(scenario, store.getState(), result),
        llmCalls: result.metrics.llmCalls,
        latencyMs: result.metrics.latencyMs,
      });
    }
  }
  console.log(formatTable(rows));
  return rows.every((row) => row.check.ok) ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseBenchArgs(argv);
  if (!parsed.ok) {
    console.error(`Invalid arguments: ${parsed.message}`);
    return 2;
  }
  try {
    return await runBench(parsed.options);
  } catch (error) {
    const { name, message } = toRunError(error);
    console.error(`${name}: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
