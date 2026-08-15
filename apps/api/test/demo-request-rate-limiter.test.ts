import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { DemoRequestRateLimiter } from "../src/modules/demo-requests/demo-request-rate-limiter";

const DEFAULT_OPTIONS = {
  windowMs: 15 * 60 * 1_000,
  sourceBudget: 5,
  globalBudget: 100,
  maxTrackedWindows: 10_000,
} as const;

function expectRateLimited(action: () => void): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HttpException);
  const exception = thrown as HttpException;
  expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  expect(exception.getResponse()).toEqual({ code: "rate_limited" });
}

describe("DemoRequestRateLimiter", () => {
  it("reports a source-scoped rejection without the source value", () => {
    const events: unknown[] = [];
    const limiter = new DemoRequestRateLimiter(DEFAULT_OPTIONS, {
      record: (event) => events.push(event),
    });
    const now = 1_000_000;

    for (let request = 1; request <= 5; request += 1) {
      expect(() => limiter.assertAllowed("203.0.113.7", now)).not.toThrow();
    }
    expectRateLimited(() => limiter.assertAllowed("203.0.113.7", now));
    expect(events).toEqual([{ event: "landing_demo_request_rate_limited", scope: "source" }]);
    expect(JSON.stringify(events)).not.toContain("203.0.113.7");
  });

  it("reports a global-scoped rejection across distinct sources", () => {
    const events: unknown[] = [];
    const limiter = new DemoRequestRateLimiter(DEFAULT_OPTIONS, {
      record: (event) => events.push(event),
    });
    const now = 1_000_000;

    for (let request = 1; request <= 100; request += 1) {
      expect(() => limiter.assertAllowed(`source-${request}`, now)).not.toThrow();
    }
    expectRateLimited(() => limiter.assertAllowed("source-101", now));
    expect(events).toEqual([{ event: "landing_demo_request_rate_limited", scope: "global" }]);
    expect(JSON.stringify(events)).not.toContain("source-101");
  });

  it("reports global scope once when both budgets are exceeded", () => {
    const events: unknown[] = [];
    const limiter = new DemoRequestRateLimiter(
      { ...DEFAULT_OPTIONS, sourceBudget: 1, globalBudget: 1 },
      { record: (event) => events.push(event) },
    );
    const now = 1_000_000;

    limiter.assertAllowed("private-source", now);
    expectRateLimited(() => limiter.assertAllowed("private-source", now));

    expect(events).toEqual([{ event: "landing_demo_request_rate_limited", scope: "global" }]);
    expect(JSON.stringify(events)).not.toContain("private-source");
  });

  it("charges the global window even when a source is already over budget", () => {
    const limiter = new DemoRequestRateLimiter(DEFAULT_OPTIONS);
    const now = 1_000_000;

    for (let request = 1; request <= 5; request += 1) {
      limiter.assertAllowed("repeated-source", now);
    }
    expectRateLimited(() => limiter.assertAllowed("repeated-source", now));

    for (let request = 1; request <= 94; request += 1) {
      limiter.assertAllowed(`distinct-${request}`, now);
    }
    expectRateLimited(() => limiter.assertAllowed("global-101", now));
  });

  it("opens fresh source and global windows at exactly 900,000 ms", () => {
    const limiter = new DemoRequestRateLimiter(DEFAULT_OPTIONS);
    const startedAt = 1_000_000;

    for (let request = 1; request <= 5; request += 1) {
      limiter.assertAllowed("203.0.113.7", startedAt);
    }
    expectRateLimited(() => limiter.assertAllowed("203.0.113.7", startedAt + 899_999));
    expect(() => limiter.assertAllowed("203.0.113.7", startedAt + 900_000)).not.toThrow();
  });

  it("normalizes blank sources and truncates source keys to 128 characters", () => {
    const limiter = new DemoRequestRateLimiter({
      ...DEFAULT_OPTIONS,
      sourceBudget: 1,
    });
    const now = 1_000_000;

    limiter.assertAllowed("   ", now);
    expectRateLimited(() => limiter.assertAllowed("", now));

    const prefix = "x".repeat(128);
    limiter.assertAllowed(`${prefix}-first`, now);
    expectRateLimited(() => limiter.assertAllowed(`${prefix}-second`, now));
  });

  it("collapses extra unique sources into one bounded overflow window", () => {
    const limiter = new DemoRequestRateLimiter({
      ...DEFAULT_OPTIONS,
      maxTrackedWindows: 4,
    });
    const now = 1_000_000;

    // The four-window bound reserves one global and one overflow window,
    // leaving two exact source keys.
    for (let source = 1; source <= 2; source += 1) {
      limiter.assertAllowed(`tracked-${source}`, now);
    }
    for (let source = 1; source <= 5; source += 1) {
      expect(() => limiter.assertAllowed(`overflow-${source}`, now)).not.toThrow();
    }
    expectRateLimited(() => limiter.assertAllowed("overflow-6", now));
  });
});
