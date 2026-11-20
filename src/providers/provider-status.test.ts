import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STATUS_URLS,
  checkProviderStatus,
  classifyError,
  classifyResponse,
  formatFailure,
  formatStatusLine,
  isRetryable,
  type FetchLike,
} from "./provider-status.ts";

const body = (indicator: string, description: string) => ({ status: { indicator, description } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** A fake fetch that plays the given steps in order and records every URL. */
function scripted(...steps: Array<Response | Error | ((signal: AbortSignal) => Promise<Response>)>) {
  const urls: string[] = [];
  const fake: FetchLike = async (url, { signal }) => {
    urls.push(url);
    const step = steps[urls.length - 1] ?? steps[steps.length - 1];
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(signal);
    return step!.clone();
  };
  return { fake, urls };
}

describe("classifyResponse", () => {
  it("accepts a valid body, trims it and drops extra fields", () => {
    const outcome = classifyResponse(200, { page: { id: "x" }, status: { indicator: " none ", description: " ok ", extra: 1 } });
    assert.deepEqual(outcome, { ok: true, indicator: "none", description: "ok" });
  });

  it("lets an unknown non-empty indicator through", () => {
    assert.deepEqual(classifyResponse(200, body("maintenance", "Scheduled")), {
      ok: true,
      indicator: "maintenance",
      description: "Scheduled",
    });
  });

  it("maps non-2xx statuses to an http failure", () => {
    for (const status of [503, 404, 429, 302]) {
      assert.deepEqual(classifyResponse(status, undefined), { ok: false, failure: { kind: "http", status } });
    }
  });

  it("maps a bad body to invalid", () => {
    for (const bad of [undefined, "<html>", null, {}, { status: {} }, body("", "x"), body("none", "  ")]) {
      assert.deepEqual(classifyResponse(200, bad), { ok: false, failure: { kind: "invalid" } });
    }
  });
});

describe("classifyError", () => {
  it("maps TimeoutError and AbortError to timeout", () => {
    assert.deepEqual(classifyError(new DOMException("t", "TimeoutError")), { kind: "timeout" });
    assert.deepEqual(classifyError(new DOMException("a", "AbortError")), { kind: "timeout" });
  });

  it("maps everything else to network", () => {
    assert.deepEqual(classifyError(new TypeError("fetch failed")), { kind: "network" });
    assert.deepEqual(classifyError("boom"), { kind: "network" });
  });
});

describe("isRetryable", () => {
  it("retries timeouts, network errors and 5xx", () => {
    assert.equal(isRetryable({ kind: "timeout" }), true);
    assert.equal(isRetryable({ kind: "network" }), true);
    assert.equal(isRetryable({ kind: "http", status: 500 }), true);
    assert.equal(isRetryable({ kind: "http", status: 503 }), true);
  });

  it("does not retry 4xx, 429 or an invalid body", () => {
    assert.equal(isRetryable({ kind: "http", status: 404 }), false);
    assert.equal(isRetryable({ kind: "http", status: 429 }), false);
    assert.equal(isRetryable({ kind: "invalid" }), false);
  });
});

describe("formatStatusLine", () => {
  it("renders one line", () => {
    assert.equal(
      formatStatusLine({ provider: "github", indicator: "none", description: "All Systems Operational" }),
      "github: none - All Systems Operational",
    );
  });

  it("collapses whitespace and line breaks", () => {
    const line = formatStatusLine({ provider: "github", indicator: "minor", description: "Partial\n  outage\r\nnow" });
    assert.equal(line, "github: minor - Partial outage now");
  });

  it("caps the line at 200 characters with an ellipsis", () => {
    const line = formatStatusLine({ provider: "github", indicator: "minor", description: "x".repeat(500) });
    assert.equal(line.length, 200);
    assert.ok(line.endsWith("…"));
  });
});

describe("formatFailure", () => {
  const tail = "Answer from internal alerts and tell the engineer the provider status is unknown.";
  const cases: Array<[Parameters<typeof formatFailure>[1], 1 | 2, string]> = [
    [{ kind: "timeout" }, 2, "timed out after 2 attempts"],
    [{ kind: "network" }, 2, "network error after 2 attempts"],
    [{ kind: "http", status: 503 }, 2, "HTTP 503 after 2 attempts"],
    [{ kind: "http", status: 404 }, 1, "HTTP 404"],
    [{ kind: "invalid" }, 1, "invalid response"],
    [{ kind: "invalid" }, 2, "invalid response"],
  ];

  for (const [failure, attempts, detail] of cases) {
    it(`says "${detail}" (attempts ${attempts})`, () => {
      const text = formatFailure("github", failure, attempts);
      assert.equal(text, `Error: github status check failed (${detail}). ${tail}`);
      assert.ok(!text.includes("\n"));
    });
  }
});

describe("checkProviderStatus", () => {
  it("returns the status after one call to the right URL", async () => {
    const { fake, urls } = scripted(json(body("none", "All Systems Operational")));
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.deepEqual(result, { ok: true, status: { provider: "github", indicator: "none", description: "All Systems Operational" } });
    assert.deepEqual(urls, [STATUS_URLS.github]);
  });

  it("queries only the Cloudflare page for cloudflare", async () => {
    const { fake, urls } = scripted(json(body("minor", "Minor Service Outage")));
    const result = await checkProviderStatus("cloudflare", { fetch: fake });
    assert.equal(result.ok, true);
    assert.deepEqual(urls, [STATUS_URLS.cloudflare]);
  });

  it("times out through the real signal and tries twice", async () => {
    const never = (signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const { fake, urls } = scripted(never);
    const result = await checkProviderStatus("github", { fetch: fake, timeoutMs: 20 });
    assert.deepEqual(result, { ok: false, failure: { kind: "timeout" }, attempts: 2 });
    assert.equal(urls.length, 2);
  });

  it("does not retry an invalid body", async () => {
    for (const response of [json({ status: {} }), new Response("<html>oops</html>", { status: 200 })]) {
      const { fake, urls } = scripted(response);
      const result = await checkProviderStatus("github", { fetch: fake });
      assert.deepEqual(result, { ok: false, failure: { kind: "invalid" }, attempts: 1 });
      assert.equal(urls.length, 1);
    }
  });

  it("retries once after a 503 and uses the second answer", async () => {
    const { fake, urls } = scripted(json({}, 503), json(body("none", "ok")));
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.equal(result.ok, true);
    assert.equal(urls.length, 2);
  });

  it("retries once after a network error and uses the second answer", async () => {
    const { fake, urls } = scripted(new TypeError("fetch failed"), json(body("none", "ok")));
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.equal(result.ok, true);
    assert.equal(urls.length, 2);
  });

  it("gives up after two 503s", async () => {
    const { fake, urls } = scripted(json({}, 503));
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.deepEqual(result, { ok: false, failure: { kind: "http", status: 503 }, attempts: 2 });
    assert.equal(urls.length, 2);
  });

  it("does not retry a 404", async () => {
    const { fake, urls } = scripted(json({}, 404));
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.deepEqual(result, { ok: false, failure: { kind: "http", status: 404 }, attempts: 1 });
    assert.equal(urls.length, 1);
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const fake: FetchLike = () => {
      throw new Error("sync boom");
    };
    const result = await checkProviderStatus("github", { fetch: fake });
    assert.deepEqual(result, { ok: false, failure: { kind: "network" }, attempts: 2 });
  });
});
