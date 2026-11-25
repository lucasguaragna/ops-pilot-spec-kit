import type { Metrics, NodeName, RunResult, TraceEvent } from "../domain/types.ts";

/**
 * One trace event as text. An event that came out of the production graph names its node first
 * (`react | [thought] ...`); the arena and the bench run strategies directly, so theirs print as is.
 */
export function formatEvent(event: TraceEvent & { node?: NodeName }): string {
  const text = formatBody(event);
  return event.node === undefined ? text : `${event.node} | ${text}`;
}

function formatBody(event: TraceEvent): string {
  switch (event.type) {
    case "thought":
    case "answer":
      return `[${event.type}] ${event.content}`;
    case "critique": {
      const verdict = event.approved ? "approved" : `rejected (${event.fix ?? "rerun"})`;
      return event.content ? `[critique] ${verdict}: ${event.content}` : `[critique] ${verdict}`;
    }
    case "action":
      return `[action] ${event.tool} ${JSON.stringify(event.args)}`;
    case "observation":
      return `[observation] ${event.tool}: ${event.content}`;
    case "route":
      return `[route] ${event.route} (${event.source}): ${event.reason}`;
    case "summarize":
      return `[summarize] (${event.absorbed} messages): ${event.content.trimEnd()}`;
    case "plan":
      return ["[plan]", ...event.steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
  }
}

export function formatMetrics(metrics: Metrics): string {
  return `llmCalls: ${metrics.llmCalls} | latencyMs: ${metrics.latencyMs}`;
}

export function formatResult(name: string, result: RunResult): string {
  const stopReason =
    result.stopReason === "error"
      ? `error (${result.error.name}: ${result.error.message})`
      : result.stopReason;
  return [
    `=== ${name} ===`,
    ...result.trace.map(formatEvent),
    `Answer: ${result.answer ?? "(none)"}`,
    `Stop reason: ${stopReason}`,
    formatMetrics(result.metrics),
  ].join("\n");
}
