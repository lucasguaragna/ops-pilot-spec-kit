import type { NodeName, NodeTraceEvent, Route, RunResult, TraceEvent } from "../domain/types.ts";

/** Pure: puts the node that produced the events on each of them. The input is not changed. */
export function tagNode(events: readonly TraceEvent[], node: NodeName): NodeTraceEvent[] {
  return events.map((event) => ({ ...event, node }));
}

/**
 * Pure: a strategy's trace tagged with its route. On a completed run the last `answer` event moves
 * to the `response` node, so the final answer appears once and belongs to the step that gives it.
 * Earlier `answer` events (drafts that reflection rejected) stay with the strategy. A run that hit
 * the iteration limit or failed has no final answer, so every event stays with the strategy.
 */
export function finalizeTrace(route: Route, result: RunResult): NodeTraceEvent[] {
  const tagged = tagNode(result.trace, route);
  if (result.stopReason !== "completed") return tagged;
  const last = tagged.findLastIndex((event) => event.type === "answer");
  return last === -1 ? tagged : tagged.map((event, index): NodeTraceEvent => (index === last ? { ...event, node: "response" } : event));
}
