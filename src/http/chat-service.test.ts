import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWithTimeout } from "./chat-service.ts";

describe("runWithTimeout", () => {
  it("resolves done with the value when the run finishes first", async () => {
    const outcome = await runWithTimeout(async () => "value", 1000);
    assert.deepEqual(outcome, { kind: "done", value: "value" });
  });

  it("resolves timeout and aborts the signal when the run never finishes", async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();

    const outcome = await runWithTimeout((signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    }, 30);

    assert.deepEqual(outcome, { kind: "timeout" });
    assert.equal(seen?.aborted, true);
    assert.ok(Date.now() - started >= 25);
  });

  it("resolves thrown when the run rejects", async () => {
    const error = new Error("boom");
    const outcome = await runWithTimeout(async () => {
      throw error;
    }, 1000);
    assert.deepEqual(outcome, { kind: "thrown", error });
  });

  it("clears the timer, so a finished run does not keep the process alive", async () => {
    const originalClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared += 1;
      originalClear(handle);
    }) as typeof clearTimeout;
    try {
      await runWithTimeout(async () => 1, 60_000);
    } finally {
      globalThis.clearTimeout = originalClear;
    }
    assert.equal(cleared, 1);
  });
});
