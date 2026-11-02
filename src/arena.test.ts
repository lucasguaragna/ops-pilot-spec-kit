import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_INPUT, parseArenaArgs } from "./arena.ts";

describe("parseArenaArgs", () => {
  it("applies defaults", () => {
    assert.deepEqual(parseArenaArgs([]), {
      ok: true,
      options: { input: DEFAULT_INPUT, strategies: ["react", "plan-execute"], maxIterations: 10 },
    });
  });

  it("reads every flag", () => {
    const parsed = parseArenaArgs(["--input", "List alerts", "--strategies", "plan-execute", "--max-iterations", "3"]);
    assert.deepEqual(parsed, {
      ok: true,
      options: { input: "List alerts", strategies: ["plan-execute"], maxIterations: 3 },
    });
  });

  it("takes a positional argument as the input, trimmed", () => {
    const parsed = parseArenaArgs(["\nquantos alertas críticos estão disparando?", "--strategies", "react"]);
    assert.deepEqual(parsed, {
      ok: true,
      options: { input: "quantos alertas críticos estão disparando?", strategies: ["react"], maxIterations: 10 },
    });
  });

  it("joins unquoted words into one input", () => {
    const parsed = parseArenaArgs(["list", "firing", "alerts"]);
    assert.ok(parsed.ok);
    assert.equal(parsed.options.input, "list firing alerts");
  });

  it("rejects a positional input together with --input", () => {
    const parsed = parseArenaArgs(["list alerts", "--input", "open incident"]);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.message.includes("--input"));
  });

  it("trims strategy names and drops duplicates", () => {
    const parsed = parseArenaArgs(["--strategies", " react , react,plan-execute"]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options.strategies, ["react", "plan-execute"]);
  });

  it("rejects an unknown strategy", () => {
    const parsed = parseArenaArgs(["--strategies", "react,unknown"]);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.message.includes("unknown"));
  });

  it("accepts the reflected strategies", () => {
    const parsed = parseArenaArgs(["--strategies", "react,reflect:react,reflect:plan-execute"]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options.strategies, ["react", "reflect:react", "reflect:plan-execute"]);
  });

  it("accepts every name derived from the shared registry", () => {
    const parsed = parseArenaArgs([
      "--strategies",
      "react,plan-execute,reflect:react,reflect:plan-execute",
    ]);
    assert.ok(parsed.ok);
    assert.equal(parseArenaArgs(["--strategies", "foo"]).ok, false);
  });

  it("lists the reflected strategies when a name is unknown", () => {
    const parsed = parseArenaArgs(["--strategies", "reflect:unknown"]);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /reflect:react/);
    assert.match(parsed.message, /reflect:plan-execute/);
  });

  it("rejects an invalid iteration limit", () => {
    for (const value of ["0", "-1", "2.5", "ten"]) {
      assert.equal(parseArenaArgs(["--max-iterations", value]).ok, false, value);
    }
  });

  it("rejects an empty input and unknown flags", () => {
    assert.equal(parseArenaArgs(["--input", "  "]).ok, false);
    assert.equal(parseArenaArgs(["--verbose"]).ok, false);
  });
});
