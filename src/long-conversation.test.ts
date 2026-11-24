import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunResult } from "./domain/types.ts";
import {
  closeServers,
  completed,
  fakeStrategy,
  settingsFor,
  startServer,
} from "./testing/test-server.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/long-conversation.sh", import.meta.url));

const hasTools = (() => {
  try {
    execFileSync("sh", ["-c", "command -v bash && command -v curl && command -v jq"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

after(closeServers);

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the script with only the variables given, so a TURNS or OPSPILOT_URL in the shell never leaks in. */
function runScript(env: { OPSPILOT_URL?: string; TURNS?: string }): Promise<ScriptRun> {
  const { TURNS: _turns, OPSPILOT_URL: _url, ...inherited } = process.env;
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT], { env: { ...inherited, ...env } }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

const lines = (run: ScriptRun) => run.stdout.split("\n").filter((line) => line !== "");

const withTokens = (promptTokens: number | null): RunResult => ({
  ...completed("ok"),
  metrics: { llmCalls: 1, latencyMs: 1, promptTokens },
});

const failed: RunResult = {
  stopReason: "error",
  answer: null,
  error: { name: "Error", message: "Provider returned 503" },
  trace: [],
  metrics: { llmCalls: 1, latencyMs: 1, promptTokens: 40 },
};

/** A react strategy that answers each call from a list, repeating the last, and records its inputs. */
function turnByTurn(results: (() => Promise<RunResult>)[]) {
  let call = 0;
  return fakeStrategy("react", () => {
    const next = results[Math.min(call, results.length - 1)];
    call += 1;
    if (next === undefined) throw new Error("no results");
    return next();
  });
}

const ok = (promptTokens: number | null) => async () => withTokens(promptTokens);

/** A port nothing listens on: bind a port, note it, release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("scripts/long-conversation.sh", { skip: !hasTools && "needs bash, curl, and jq" }, () => {
  it("prints one line per turn in one conversation, with the real promptTokens (US3-AS1)", async () => {
    const react = turnByTurn([ok(1000)]);
    const baseUrl = await startServer(settingsFor({ react }));

    const run = await runScript({ OPSPILOT_URL: baseUrl, TURNS: "3" });

    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.equal(lines(run)[0], "turn 1 | promptTokens 1000 | history 0 (0 messages)");
    assert.match(lines(run)[1] ?? "", /^turn 2 \| promptTokens 1000 \| history [1-9]\d* \(2 messages\)$/);
    assert.match(lines(run)[2] ?? "", /^turn 3 \| promptTokens 1000 \| history [1-9]\d* \(4 messages\)$/);
    assert.equal(lines(run).length, 3);
    // Same conversation: each turn saw the earlier ones, and the first turn sent the first message.
    assert.equal(react.calls[0]?.input, "Which alerts are firing right now?");
    assert.match(react.calls[2]?.input ?? "", /^Conversation so far/);
  });

  it("shows where the history stops growing at the 12-message limit (SC-003)", async () => {
    const baseUrl = await startServer(settingsFor({ react: turnByTurn([ok(500)]) }));

    const run = await runScript({ OPSPILOT_URL: baseUrl, TURNS: "8" });

    const counts = lines(run).map((line) => /\((\d+) messages\)/.exec(line)?.[1]);
    assert.deepEqual(counts, ["0", "2", "4", "6", "8", "10", "12", "12"]);
  });

  it("prints n/a when the server reports no promptTokens (US3-AS3)", async () => {
    const baseUrl = await startServer(settingsFor({ react: turnByTurn([ok(null)]) }));

    const run = await runScript({ OPSPILOT_URL: baseUrl, TURNS: "1" });

    assert.equal(lines(run)[0], "turn 1 | promptTokens n/a | history 0 (0 messages)");
  });

  it("prints the error code of a 502 turn and carries on (US3-AS2)", async (t) => {
    // The server logs the failed run; keep that line out of the test report.
    t.mock.method(console, "error", () => {});
    const react = turnByTurn([ok(1000), async () => failed, ok(1000)]);
    const baseUrl = await startServer(settingsFor({ react }));

    const run = await runScript({ OPSPILOT_URL: baseUrl, TURNS: "3" });

    assert.equal(run.code, 0);
    assert.equal(lines(run)[1], "turn 2 | error run_failed");
    assert.match(lines(run)[2] ?? "", /^turn 3 \| promptTokens 1000 \|/);
  });

  it("prints the error code of a 504 turn and carries on (US3-AS2)", async () => {
    const hang = () => new Promise<RunResult>(() => {});
    const react = turnByTurn([ok(1000), hang, ok(1000)]);
    const baseUrl = await startServer(settingsFor({ react }, { timeoutMs: 50 }));

    const run = await runScript({ OPSPILOT_URL: baseUrl, TURNS: "3" });

    assert.equal(run.code, 0);
    assert.equal(lines(run)[1], "turn 2 | error timeout");
    assert.match(lines(run)[2] ?? "", /^turn 3 \| promptTokens 1000 \|/);
  });

  it("accepts a trailing slash on OPSPILOT_URL", async () => {
    const baseUrl = await startServer(settingsFor({ react: turnByTurn([ok(7)]) }));

    const run = await runScript({ OPSPILOT_URL: `${baseUrl}/`, TURNS: "1" });

    assert.equal(lines(run)[0], "turn 1 | promptTokens 7 | history 0 (0 messages)");
  });

  it("runs 10 turns by default", async () => {
    const baseUrl = await startServer(settingsFor({ react: turnByTurn([ok(1)]) }));

    const run = await runScript({ OPSPILOT_URL: baseUrl });

    assert.equal(lines(run).length, 10);
  });

  it("exits 1 and names the URL when the server is not running (US3-AS4)", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;

    const run = await runScript({ OPSPILOT_URL: url, TURNS: "2" });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr.trim(), `Cannot reach ${url}`);
  });

  it("exits 2 for a TURNS that is not a positive integer", async () => {
    for (const TURNS of ["0", "abc", "-3", "1.5"]) {
      const run = await runScript({ OPSPILOT_URL: "http://127.0.0.1:1", TURNS });
      assert.equal(run.code, 2, `TURNS=${JSON.stringify(TURNS)}`);
      assert.equal(run.stderr.trim(), "TURNS must be a positive integer");
    }
  });
});
