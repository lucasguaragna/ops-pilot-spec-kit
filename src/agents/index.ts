import { UnknownStrategyError } from "../domain/errors.ts";
import type { ReasoningStrategy, Route } from "../domain/types.ts";
import { withReflection } from "./reflection.ts";
import { createPlanExecuteStrategy } from "./plan-and-execute.ts";
import { createReactStrategy, type StrategyDependencies } from "./react.ts";

export type StrategyFactory = (dependencies: StrategyDependencies) => ReasoningStrategy;
export type StrategyRegistry = Readonly<Record<string, StrategyFactory>>;

/** The base strategies by name. Reflection is not listed: it wraps any of them per request. */
export const strategyFactories = {
  react: createReactStrategy,
  "plan-execute": createPlanExecuteStrategy,
} satisfies StrategyRegistry;

/** Looks a strategy up by exact name, wrapped with reflection when asked. Throws UnknownStrategyError when the registry lacks it. */
export function createStrategy(
  registry: StrategyRegistry,
  name: string,
  dependencies: StrategyDependencies,
  { reflect }: { reflect: boolean },
): ReasoningStrategy {
  // hasOwn keeps inherited keys such as "toString" from resolving to a function.
  if (!Object.hasOwn(registry, name)) throw new UnknownStrategyError(name, Object.keys(registry));
  const factory = registry[name] as StrategyFactory;
  const base = factory(dependencies);
  return reflect ? withReflection(base, { model: dependencies.model }) : base;
}

/**
 * The strategy of a route: `react` and `plan-execute` come from the registry, and `reflect` is ReAct
 * wrapped with reflection. Reflection is not in the registry, so the arena never lists `reflect:reflect`.
 */
export function createRouteStrategy(
  registry: StrategyRegistry,
  route: Route,
  dependencies: StrategyDependencies,
): ReasoningStrategy {
  return route === "reflect"
    ? createStrategy(registry, "react", dependencies, { reflect: true })
    : createStrategy(registry, route, dependencies, { reflect: false });
}
