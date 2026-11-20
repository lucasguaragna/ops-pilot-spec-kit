import { z } from "zod";
import type { Provider } from "../domain/schemas.ts";

/** Fixed status pages. Typed as a Record so a provider without a URL fails type-checking. */
export const STATUS_URLS: Record<Provider, string> = {
  github: "https://www.githubstatus.com/api/v2/status.json",
  cloudflare: "https://www.cloudflarestatus.com/api/v2/status.json",
};

/**
 * Body of a statuspage.io `status.json`. Extra fields are dropped. The indicator is not an enum:
 * an unknown non-empty value (for example `maintenance`) must pass through.
 */
export const StatusPageBody = z.object({
  status: z.object({
    indicator: z.string().trim().min(1),
    description: z.string().trim().min(1),
  }),
});

/** The part of `fetch` this module needs. The global `fetch` satisfies it. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type ProviderStatus = { provider: Provider; indicator: string; description: string };

export type Failure =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "http"; status: number }
  | { kind: "invalid" };

export type Outcome = { ok: true; indicator: string; description: string } | { ok: false; failure: Failure };

export type CheckResult =
  | { ok: true; status: ProviderStatus }
  | { ok: false; failure: Failure; attempts: 1 | 2 };

export type CheckDeps = { fetch?: FetchLike; timeoutMs?: number };

export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_LINE_LENGTH = 200;

/** Turns an HTTP status and a parsed body (or `undefined` when it could not be parsed) into an outcome. */
export function classifyResponse(status: number, body: unknown): Outcome {
  if (status < 200 || status >= 300) return { ok: false, failure: { kind: "http", status } };
  const parsed = StatusPageBody.safeParse(body);
  if (!parsed.success) return { ok: false, failure: { kind: "invalid" } };
  return { ok: true, ...parsed.data.status };
}

/** A timeout is a network failure with its own name; every other thrown value is a plain network failure. */
export function classifyError(error: unknown): Failure {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
}

/**
 * One retry is worth it only when the problem can pass by itself: a timeout, a network error, or a
 * server error (5xx). A client error (4xx, including 429, which would need a wait) and an invalid
 * body repeat the same way, so retrying only adds seconds during an incident.
 */
export function isRetryable(failure: Failure): boolean {
  switch (failure.kind) {
    case "timeout":
    case "network":
      return true;
    case "http":
      return failure.status >= 500;
    case "invalid":
      return false;
  }
}

/** `<provider>: <indicator> - <description>` on one line, at most 200 characters. */
export function formatStatusLine({ provider, indicator, description }: ProviderStatus): string {
  const line = `${provider}: ${indicator} - ${description}`.replace(/\s+/g, " ");
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
}

/** The `Error:` text for the model. The detail describes the last attempt's failure. */
export function formatFailure(provider: Provider, failure: Failure, attempts: 1 | 2): string {
  const after = attempts === 2 ? " after 2 attempts" : "";
  let detail: string;
  switch (failure.kind) {
    case "timeout":
      detail = `timed out${after}`;
      break;
    case "network":
      detail = `network error${after}`;
      break;
    case "http":
      detail = `HTTP ${failure.status}${after}`;
      break;
    case "invalid":
      detail = "invalid response";
      break;
  }
  return (
    `Error: ${provider} status check failed (${detail}). ` +
    "Answer from internal alerts and tell the engineer the provider status is unknown."
  );
}

/** A body that is not JSON is an invalid response; any other read error (an abort) is let through. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function attempt(provider: Provider, doFetch: FetchLike, timeoutMs: number): Promise<Outcome> {
  try {
    const response = await doFetch(STATUS_URLS[provider], { signal: AbortSignal.timeout(timeoutMs) });
    const body = response.ok ? await readJson(response) : undefined;
    return classifyResponse(response.status, body);
  } catch (error) {
    return { ok: false, failure: classifyError(error) };
  }
}

/** At most two attempts. Returns a value in every case and never throws. */
export async function checkProviderStatus(provider: Provider, deps: CheckDeps = {}): Promise<CheckResult> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const first = await attempt(provider, doFetch, timeoutMs);
  if (first.ok) return { ok: true, status: { provider, indicator: first.indicator, description: first.description } };
  if (!isRetryable(first.failure)) return { ok: false, failure: first.failure, attempts: 1 };

  const second = await attempt(provider, doFetch, timeoutMs);
  if (second.ok) return { ok: true, status: { provider, indicator: second.indicator, description: second.description } };
  return { ok: false, failure: second.failure, attempts: 2 };
}
