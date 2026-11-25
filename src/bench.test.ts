import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenIncidentInput } from "./domain/schemas.ts";
import type { RunResult } from "./domain/types.ts";
import { createInitialState, openIncident, resolveIncident, type StoreState } from "./store/in-memory-store.ts";
import {
  checkCriticalCount,
  checkOldestIncident,
  checkThreeIncidents,
  formatTable,
  judge,
  mentionsCount,
  oldestFiring,
  parseBenchArgs,
  SCENARIOS,
} from "./bench.ts";

const open = (state: StoreState, service: string, severity: OpenIncidentInput["severity"] = "high") =>
  openIncident(state, { title: `Incident for ${service}`, service, severity }).state;

function threeIncidents(severity: OpenIncidentInput["severity"] = "high"): StoreState {
  const opened = ["checkout-api", "payments-worker", "catalog-api"].reduce(
    (state, service) => open(state, service, severity),
    createInitialState(),
  );
  return resolveIncident(opened, { id: "INC-001" }, "2026-11-02T12:00:00.000Z").state;
}

describe("parseBenchArgs", () => {
  it("defaults to every scenario with the replanner on", () => {
    assert.deepEqual(parseBenchArgs([]), { ok: true, options: { scenarios: ["C1", "C2", "C3"], replanner: true } });
  });

  it("reads --scenario as a case-insensitive list and --no-replanner", () => {
    assert.deepEqual(parseBenchArgs(["--scenario", "c3, C1,c3", "--no-replanner"]), {
      ok: true,
      options: { scenarios: ["C3", "C1"], replanner: false },
    });
  });

  it("rejects an unknown scenario and an unknown flag", () => {
    const unknown = parseBenchArgs(["--scenario", "C4"]);
    assert.ok(!unknown.ok && unknown.message.includes("Known: C1, C2, C3"));
    assert.equal(parseBenchArgs(["--fast"]).ok, false);
  });
});

describe("mentionsCount", () => {
  it("finds the count as a digit or a word", () => {
    assert.ok(mentionsCount("Há 1 alerta crítico", 1));
    assert.ok(mentionsCount("Existe um alerta crítico disparando", 1));
    assert.ok(mentionsCount("Sobraram três alertas", 3));
    assert.ok(mentionsCount("Three alerts are left.", 3));
  });

  it("ignores digits inside ids and other numbers", () => {
    assert.equal(mentionsCount("ALT-001 and ALT-003 fired 10 minutes ago", 1), false);
    assert.equal(mentionsCount("Sobraram 13 alertas", 3), false);
  });
});

describe("oldestFiring", () => {
  it("uses firedAt, not the id", () => {
    assert.equal(oldestFiring(createInitialState())?.id, "ALT-003");
  });
});

describe("scenario checks", () => {
  it("C1 needs the critical count and no incidents", () => {
    assert.equal(checkCriticalCount(createInitialState(), "Há 1 alerta crítico disparando.").ok, true);
    assert.equal(checkCriticalCount(createInitialState(), "Há 2 alertas críticos.").ok, false);
    assert.equal(checkCriticalCount(open(createInitialState(), "payments-worker"), "Há 1 alerta.").ok, false);
  });

  it("C2 needs three sev2 incidents in order with only the first resolved", () => {
    assert.deepEqual(checkThreeIncidents(threeIncidents()), { ok: true, reason: "" });
    assert.match(checkThreeIncidents(threeIncidents("critical")).reason, /sev2/);
    const swapped = open(open(createInitialState(), "payments-worker"), "checkout-api");
    assert.match(checkThreeIncidents(swapped).reason, /payments-worker:open, checkout-api:open/);
  });

  it("C3 needs one open incident for the oldest firing alert and the count left", () => {
    const oldest = open(createInitialState(), "auth-service");
    assert.equal(checkOldestIncident(oldest, "Abri INC-001; sobraram 3 alertas.").ok, true);
    assert.match(checkOldestIncident(oldest, "Abri INC-001; sobraram 4.").reason, /3 left/);
    const byId = open(createInitialState(), "checkout-api");
    assert.match(checkOldestIncident(byId, "Sobraram 3.").reason, /oldest is auth-service/);
  });
});

describe("judge", () => {
  const metrics = { llmCalls: 1, latencyMs: 1, promptTokens: null, modelUsed: null };
  const [c1] = SCENARIOS;

  it("fails a run that did not complete, whatever the state", () => {
    assert.ok(c1);
    const limited: RunResult = { stopReason: "iteration_limit", answer: null, trace: [], metrics };
    assert.deepEqual(judge(c1, createInitialState(), limited), { ok: false, reason: "iteration_limit" });
  });
});

describe("formatTable", () => {
  it("prints the consolidated table and lists failures", () => {
    const table = formatTable([
      { scenario: "C1 direto", strategy: "react", check: { ok: true, reason: "" }, llmCalls: 2, latencyMs: 900 },
      {
        scenario: "C1 direto",
        strategy: "plan-execute",
        check: { ok: false, reason: "answer does not state 1" },
        llmCalls: 4,
        latencyMs: 12000,
      },
    ]);
    assert.equal(
      table,
      [
        "| cenário   | estratégia   | acerto | llmCalls | latencyMs |",
        "| --------- | ------------ | ------ | -------- | --------- |",
        "| C1 direto | react        | sim    | 2        | 900       |",
        "| C1 direto | plan-execute | não    | 4        | 12000     |",
        "",
        "Falhas:",
        "- C1 direto plan-execute: answer does not state 1",
      ].join("\n"),
    );
  });
});
