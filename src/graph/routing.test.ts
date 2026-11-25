import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnknownStrategyError } from "../domain/errors.ts";
import { decideRoute, requestedRoute, ROUTER_PROMPT, ROUTES, routeOf } from "./routing.ts";

describe("decideRoute", () => {
  it("marks an override with the fixed reason", () => {
    assert.deepEqual(decideRoute({ kind: "override", route: "plan-execute" }), {
      route: "plan-execute",
      reason: "Requested by the caller",
      source: "override",
    });
  });

  it("takes a valid answer, with its reason trimmed", () => {
    assert.deepEqual(decideRoute({ kind: "answered", parsed: { route: "reflect", reason: "  Needs a check  " } }), {
      route: "reflect",
      reason: "Needs a check",
      source: "router",
    });
  });

  it("replaces an empty reason and keeps a long one", () => {
    const empty = decideRoute({ kind: "answered", parsed: { route: "react", reason: "   " } });
    assert.equal(empty.reason, "No reason given");
    const long = "x".repeat(2000);
    assert.equal(decideRoute({ kind: "answered", parsed: { route: "react", reason: long } }).reason, long);
  });

  for (const parsed of [null, undefined, { route: "nope", reason: "x" }, { route: "react" }, "react"]) {
    it(`falls back to react for ${JSON.stringify(parsed)}`, () => {
      assert.deepEqual(decideRoute({ kind: "answered", parsed }), {
        route: "react",
        reason: "Router failed: invalid answer",
        source: "fallback",
      });
    });
  }

  it("falls back with the error class name and never its message", () => {
    const decision = decideRoute({ kind: "thrown", error: new TypeError("secret provider text") });
    assert.deepEqual(decision, { route: "react", reason: "Router failed: TypeError", source: "fallback" });
    assert.equal(decideRoute({ kind: "thrown", error: "boom" }).reason, "Router failed: unknown error");
  });
});

describe("routeOf", () => {
  it("is the decided route", () => {
    assert.equal(routeOf({ decision: { route: "plan-execute", reason: "r", source: "router" } }), "plan-execute");
  });

  it("throws when the router left no decision", () => {
    assert.throws(() => routeOf({}), /no decision/);
  });
});

describe("requestedRoute", () => {
  it("lets the router decide when nothing is forced", () => {
    assert.equal(requestedRoute({}), undefined);
    assert.equal(requestedRoute({ reflect: false }), undefined);
  });

  it("forces a known strategy", () => {
    assert.equal(requestedRoute({ strategy: "plan-execute" }), "plan-execute");
    assert.equal(requestedRoute({ strategy: "react", reflect: false }), "react");
  });

  it("treats reflect: true as the reflect route", () => {
    assert.equal(requestedRoute({ reflect: true }), "reflect");
    assert.equal(requestedRoute({ strategy: "reflect", reflect: true }), "reflect");
  });

  for (const name of ["nope", "React", "toString", "reflect:react"]) {
    it(`throws UnknownStrategyError for "${name}" listing the three routes`, () => {
      assert.throws(
        () => requestedRoute({ strategy: name }),
        (error: unknown) =>
          error instanceof UnknownStrategyError &&
          error.strategy === name &&
          JSON.stringify(error.knownStrategies) === JSON.stringify(["react", "plan-execute", "reflect"]),
      );
    });
  }
});

describe("ROUTER_PROMPT", () => {
  it("lists every route and tells the router to choose react when unsure", () => {
    for (const route of ROUTES) assert.ok(ROUTER_PROMPT.includes(`| ${route} |`), route);
    assert.ok(ROUTER_PROMPT.includes("When unsure, choose react."));
  });
});
